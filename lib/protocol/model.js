/**
 * Protocol model: validation, persistence and discovery.
 *
 * A protocol model is a JSON document that describes ONE wire protocol on a
 * byte stream: how a frame is delimited, where the length field is, which
 * checksum is used and what commands/status codes mean. It contains no code
 * and no per-project paths, so the same model can be committed and shared with
 * teammates.
 *
 * Layout: <project>/.dsh/protocols/<name>.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { CHECKSUM_ALGORITHMS, checksumWidth } from './crc.js'

export const PROTOCOL_DIR = join('.dsh', 'protocols')
export const MODEL_SCHEMA_VERSION = 1

export const FIELD_TYPES = ['u8', 'u16', 'u32', 'i8', 'i16', 'i32']
export const COVERAGES = ['frame', 'header+payload', 'payload']
export const BYTE_ORDERS = ['be', 'le']
export const PARITIES = ['None', 'Odd', 'Even', 'Mark', 'Space']

const PARITY_BY_VALUE = new Map([
  ['none', 'None'],
  ['n', 'None'],
  ['0', 'None'],
  ['odd', 'Odd'],
  ['o', 'Odd'],
  ['even', 'Even'],
  ['e', 'Even'],
  ['mark', 'Mark'],
  ['m', 'Mark'],
  ['space', 'Space'],
  ['s', 'Space'],
])

const STOP_BYTES_BY_VALUE = new Map([
  ['one', 'One'],
  ['1', 'One'],
  ['onepointfive', 'OnePointFive'],
  ['1.5', 'OnePointFive'],
  ['two', 'Two'],
  ['2', 'Two'],
])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0
}

function validateField(field, path, errors) {
  if (!isPlainObject(field)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }
  const name = titleCaseName(field.name)
  if (name === undefined) {
    errors.push(`${path}.name: must be a non-empty string`)
    return undefined
  }
  const type = typeof field.type === 'string' ? field.type.toLowerCase() : 'u8'
  if (!FIELD_TYPES.includes(type)) {
    errors.push(`${path}.type: must be one of ${FIELD_TYPES.join(', ')}`)
    return undefined
  }
  if (type !== 'u8' && field.endian !== undefined && !BYTE_ORDERS.includes(field.endian)) {
    errors.push(`${path}.endian: must be one of ${BYTE_ORDERS.join(', ')}`)
  }
  return { name, type, ...(type === 'u8' ? {} : { endian: field.endian ?? 'be' }) }
}

function titleCaseName(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64) return undefined
  return trimmed
}

function normalizeFields(raw, path, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${path}: must be a non-empty array`)
    return undefined
  }
  const fields = []
  const seen = new Set()
  for (const [index, field] of raw.entries()) {
    const normalized = validateField(field, `${path}[${index}]`, errors)
    if (normalized === undefined) return undefined
    if (seen.has(normalized.name)) {
      errors.push(`${path}[${index}].name: duplicate field name "${normalized.name}"`)
      return undefined
    }
    seen.add(normalized.name)
    fields.push(normalized)
  }
  return fields
}

function normalizeTransport(raw, errors) {
  if (raw === undefined) {
    return { baudRate: 115200, dataBits: 8, parity: 'None', stopBits: 'One' }
  }
  if (!isPlainObject(raw)) {
    errors.push('transport: must be an object')
    return undefined
  }
  const baudRate = raw.baudRate ?? 115200
  if (!Number.isInteger(baudRate) || baudRate <= 0 || baudRate > 20_000_000) {
    errors.push('transport.baudRate: must be a positive integer')
    return undefined
  }
  const dataBits = raw.dataBits ?? 8
  if (![5, 6, 7, 8].includes(dataBits)) {
    errors.push('transport.dataBits: must be 5, 6, 7 or 8')
    return undefined
  }
  const parityKey = String(raw.parity ?? 'None').toLowerCase()
  const parity = PARITY_BY_VALUE.get(parityKey)
  if (parity === undefined) {
    errors.push('transport.parity: must be None, Odd, Even, Mark or Space')
    return undefined
  }
  const stopKey = String(raw.stopBits ?? 'One').toLowerCase()
  const stopBits = STOP_BYTES_BY_VALUE.get(stopKey)
  if (stopBits === undefined) {
    errors.push('transport.stopBits: must be One, OnePointFive or Two')
    return undefined
  }
  return { baudRate, dataBits, parity, stopBits }
}

function normalizeFraming(raw, errors) {
  if (!isPlainObject(raw)) {
    errors.push('framing: must be an object')
    return undefined
  }

  const sync = []
  for (const [index, byte] of (raw.sync ?? []).entries()) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      errors.push(`framing.sync[${index}]: must be a byte value (0-255)`)
      return undefined
    }
    sync.push(byte)
  }
  const end = raw.end ?? null
  if (end !== null && (!Number.isInteger(end) || end < 0 || end > 255)) {
    errors.push('framing.end: must be a byte value (0-255) or null')
    return undefined
  }

  const fields = normalizeFields(raw.fields, 'framing.fields', errors)
  if (fields === undefined) return undefined

  const names = fields.map(field => field.name)
  const lengthField = raw.lengthField ?? names[names.length - 1]
  if (typeof lengthField !== 'string' || !names.includes(lengthField)) {
    errors.push(`framing.lengthField: must name one of framing.fields (${names.join(', ')})`)
    return undefined
  }
  const lengthType = fields.find(field => field.name === lengthField).type
  if (!['u8', 'u16', 'u32'].includes(lengthType)) {
    errors.push('framing.lengthField: signed fields cannot be a length')
    return undefined
  }

  const lengthIncludes = raw.lengthIncludes ?? 'payload'
  if (!['payload', 'frame'].includes(lengthIncludes)) {
    errors.push('framing.lengthIncludes: must be "payload" or "frame"')
    return undefined
  }

  const checksumRaw = raw.checksum ?? { algorithm: 'none', coverage: 'frame', byteOrder: 'be' }
  if (!isPlainObject(checksumRaw)) {
    errors.push('framing.checksum: must be an object')
    return undefined
  }
  const algorithm = checksumRaw.algorithm ?? 'none'
  if (!CHECKSUM_ALGORITHMS.includes(algorithm)) {
    errors.push(`framing.checksum.algorithm: must be one of ${CHECKSUM_ALGORITHMS.join(', ')}`)
    return undefined
  }
  const width = checksumWidth(algorithm)
  if (width > 0) {
    const initRaw = checksumRaw.init ?? undefined
    if (initRaw !== undefined && (!Number.isInteger(initRaw) || initRaw < 0 || initRaw > 0xffff)) {
      errors.push('framing.checksum.init: must be an integer in 0..65535')
      return undefined
    }
    const coverage = checksumRaw.coverage ?? 'frame'
    if (!COVERAGES.includes(coverage)) {
      errors.push(`framing.checksum.coverage: must be one of ${COVERAGES.join(', ')}`)
      return undefined
    }
    const byteOrder = checksumRaw.byteOrder ?? 'be'
    if (!BYTE_ORDERS.includes(byteOrder)) {
      errors.push('framing.checksum.byteOrder: must be "be" or "le"')
      return undefined
    }
    const acceptEitherOrder = checksumRaw.acceptEitherOrder === true
    var checksum = { algorithm, width, coverage, byteOrder, acceptEitherOrder, ...(initRaw === undefined ? {} : { init: initRaw }) }
  } else {
    var checksum = { algorithm, width: 0, coverage: 'frame', byteOrder: 'be', acceptEitherOrder: false }
  }

  const maxPayloadRaw = raw.maxPayload ?? 1024
  if (!isNonNegativeInt(maxPayloadRaw) || maxPayloadRaw > 1_048_576) {
    errors.push('framing.maxPayload: must be an integer in 0..1048576')
    return undefined
  }
  const maxFrameRaw = raw.maxFrame ?? maxPayloadRaw + 32
  if (!isNonNegativeInt(maxFrameRaw) || maxFrameRaw < maxPayloadRaw + 8) {
    errors.push('framing.maxFrame: must be an integer >= maxPayload + 8')
    return undefined
  }

  const overrides = []
  for (const [index, override] of (raw.overrides ?? []).entries()) {
    if (!isPlainObject(override) || !isPlainObject(override.when) || !Number.isInteger(override.when.command)) {
      errors.push(`framing.overrides[${index}].when.command: must be an integer`)
      return undefined
    }
    if (override.when.command < 0 || override.when.command > 255) {
      errors.push(`framing.overrides[${index}].when.command: must be a byte value`)
      return undefined
    }
    const overrideFields = normalizeFields(override.fields, `framing.overrides[${index}].fields`, errors)
    if (overrideFields === undefined) return undefined
    const overrideNames = overrideFields.map(field => field.name)
    if (!overrideNames.includes(lengthField)) {
      errors.push(`framing.overrides[${index}].fields: must include length field "${lengthField}"`)
      return undefined
    }
    overrides.push({ when: { command: override.when.command }, fields: overrideFields })
  }

  const statusWhen = raw.statusWhenPayloadLength ?? 1
  if (!isNonNegativeInt(statusWhen) || statusWhen > 64) {
    errors.push('framing.statusWhenPayloadLength: must be an integer in 0..64')
    return undefined
  }

  return {
    sync,
    end,
    fields,
    lengthField,
    lengthIncludes,
    checksum,
    maxPayload: maxPayloadRaw,
    maxFrame: maxFrameRaw,
    overrides,
    statusWhenPayloadLength: statusWhen,
    payloadAsStatus: raw.payloadAsStatus !== false,
  }
}

function normalizeCodeTable(raw, kind, errors) {
  const entries = []
  const seen = new Set()
  if (raw === undefined) return entries
  if (!Array.isArray(raw)) {
    errors.push(`${kind}: must be an array`)
    return undefined
  }
  for (const [index, entry] of raw.entries()) {
    if (!isPlainObject(entry)) {
      errors.push(`${kind}[${index}]: must be an object`)
      return undefined
    }
    const code = entry.code
    if (!Number.isInteger(code) || code < 0 || code > (kind === 'commands' ? 255 : 0xffff)) {
      errors.push(`${kind}[${index}].code: must be an integer in range`)
      return undefined
    }
    if (seen.has(code)) {
      errors.push(`${kind}[${index}].code: duplicate code ${code}`)
      return undefined
    }
    seen.add(code)
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined
    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : undefined
    if (name === undefined && label === undefined) {
      errors.push(`${kind}[${index}]: needs at least a name or a label`)
      return undefined
    }
    entries.push({ code, ...(name === undefined ? {} : { name }), ...(label === undefined ? {} : { label }) })
  }
  return entries
}

/**
 * Validate and normalize a raw model document.
 *
 * Returns { ok, model, errors, warnings }; on failure `model` is undefined and
 * `errors` names the exact JSON path to fix.
 */
export function validateModel(raw) {
  const errors = []
  const warnings = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['model: must be a JSON object'], warnings }
  }
  if ((raw.schema ?? MODEL_SCHEMA_VERSION) !== MODEL_SCHEMA_VERSION) {
    errors.push(`schema: supported version is ${MODEL_SCHEMA_VERSION}`)
  }
  const name = typeof raw.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(raw.name) ? raw.name : undefined
  if (name === undefined) errors.push('name: must be 1-64 chars of A-Z a-z 0-9 _ . - and not start with .')
  const description = typeof raw.description === 'string' ? raw.description : ''

  const transport = normalizeTransport(raw.transport, errors)
  const framing = normalizeFraming(raw.framing, errors)
  const commands = normalizeCodeTable(raw.commands, 'commands', errors)
  const errorsTable = normalizeCodeTable(raw.errors, 'errors', errors)

  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter(entry => isPlainObject(entry)).map(entry => ({
        ...(typeof entry.file === 'string' ? { file: entry.file } : {}),
        ...(Number.isInteger(entry.line) ? { line: entry.line } : {}),
        ...(typeof entry.text === 'string' ? { text: entry.text.slice(0, 300) } : {}),
        ...(typeof entry.why === 'string' ? { why: entry.why } : {}),
      }))
    : []

  const notes = Array.isArray(raw.notes) ? raw.notes.filter(note => typeof note === 'string') : []

  if (errors.length > 0) return { ok: false, errors, warnings }

  const model = {
    schema: MODEL_SCHEMA_VERSION,
    name,
    ...(description === '' ? {} : { description }),
    transport,
    framing,
    commands,
    errors: errorsTable,
    evidence,
    notes,
  }

  if (framing.checksum.width > 0 && framing.checksum.init === undefined) {
    warnings.push(`framing.checksum.init: not set for ${framing.checksum.algorithm}; the algorithm default is used`)
  }
  if (framing.sync.length === 0) {
    warnings.push('framing.sync: empty — frames have no header bytes, so the parser must resynchronise by command/checksum')
  }
  if (framing.checksum.width === 0) {
    warnings.push('framing.checksum.algorithm: "none" — corrupt frames cannot be detected')
  }

  return { ok: true, model, errors: [], warnings }
}

/** Resolve the protocol directory for a project root. */
export function protocolDir(projectDir) {
  return join(resolve(projectDir), PROTOCOL_DIR)
}

/** Path of one model file; throws on a name that could escape the directory. */
export function modelPath(projectDir, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name)) {
    throw new Error(`invalid protocol name: ${String(name)}`)
  }
  return join(protocolDir(projectDir), `${name}.json`)
}

/** List model files, newest model first is not implied — alphabetical order. */
export function listModelFiles(projectDir) {
  const dir = protocolDir(projectDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => ({ name: entry.name.slice(0, -'.json'.length), path: join(dir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Load one model. Never throws for a missing/invalid file; reports diagnostics. */
export function loadModel(projectDir, name) {
  const path = modelPath(projectDir, name)
  if (!existsSync(path)) {
    return { found: false, path, diagnostics: [`protocol model not found: ${path}`] }
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { found: true, path, diagnostics: [`invalid JSON in ${path}: ${error.message}`] }
  }
  const validated = validateModel(raw)
  if (!validated.ok) {
    return { found: true, path, diagnostics: validated.errors.map(message => `${path}: ${message}`) }
  }
  return { found: true, path, model: { ...validated.model, name: validated.model.name }, diagnostics: validated.warnings, warnings: validated.warnings }
}

/** Load every model in the project; invalid files are reported, not thrown. */
export function loadModels(projectDir) {
  return listModelFiles(projectDir).map(({ name, path }) => {
    const loaded = loadModel(projectDir, name)
    return { name, path, ...loaded }
  })
}

/** Choose the model to use: explicit name, else the single model, else by name hint. */
export function resolveModel(projectDir, name) {
  const models = loadModels(projectDir).filter(entry => entry.model !== undefined)
  if (name !== undefined && name !== '') {
    const found = models.find(entry => entry.name === name)
    if (found === undefined) {
      const available = models.map(entry => entry.name).join(', ') || '(none)'
      return { found: false, diagnostics: [`protocol "${name}" not found in ${protocolDir(projectDir)}; available: ${available}`] }
    }
    return { found: true, name, path: found.path, model: found.model, diagnostics: found.diagnostics }
  }
  if (models.length === 1) {
    const only = models[0]
    return { found: true, name: only.name, path: only.path, model: only.model, diagnostics: only.diagnostics }
  }
  if (models.length === 0) {
    return { found: false, diagnostics: [`no protocol models in ${protocolDir(projectDir)} — run proto_scan first`] }
  }
  return {
    found: false,
    diagnostics: [`${models.length} protocol models exist (${models.map(entry => entry.name).join(', ')}); pass "protocol" explicitly`],
  }
}

/** Write a model document; returns { ok, path, diagnostics }. */
export function saveModel(projectDir, model, { overwrite = false } = {}) {
  const validated = validateModel(model)
  if (!validated.ok) return { ok: false, diagnostics: validated.errors }
  const path = modelPath(projectDir, validated.model.name)
  if (existsSync(path) && !overwrite) {
    return { ok: false, path, diagnostics: [`${path} already exists; pass overwrite:true to replace it`] }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(validated.model, null, 2)}\n`, 'utf8')
  return { ok: true, path, diagnostics: validated.warnings }
}

/** Compact summary used by proto_show and the scan result. */
export function summarizeModel(model) {
  const framing = model.framing
  return {
    name: model.name,
    baudRate: model.transport.baudRate,
    sync: framing.sync.map(byte => byte.toString(16).padStart(2, '0')).join(' '),
    fields: framing.fields.map(field => `${field.name}:${field.type}`).join(' '),
    lengthField: framing.lengthField,
    checksum: `${framing.checksum.algorithm}(${framing.checksum.coverage}, ${framing.checksum.byteOrder})`,
    overrides: framing.overrides.length,
    commands: model.commands.length,
    errors: model.errors.length,
  }
}
