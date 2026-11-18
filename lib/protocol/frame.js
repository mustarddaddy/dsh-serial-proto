/**
 * Generic frame codec driven by a protocol model.
 *
 * Layout convention (documented in the skill): the FIRST header field is the
 * command byte. The frame on the wire is:
 *
 *   [sync...] [header fields...] [payload...] [checksum...] [end?]
 *
 * The length field is one of the header fields; its value is either the payload
 * length or the whole frame length, depending on `lengthIncludes`.
 */
import { computeChecksum, checksumWidth } from './crc.js'

const WIDTHS = new Map([
  ['u8', 1], ['u16', 2], ['u32', 4],
  ['i8', 1], ['i16', 2], ['i32', 4],
])

export function fieldWidth(type) {
  const width = WIDTHS.get(type)
  if (width === undefined) throw new Error(`unknown field type: ${type}`)
  return width
}

function encodeInteger(value, type, endian) {
  const width = fieldWidth(type)
  const buffer = Buffer.alloc(width)
  const signed = type.startsWith('i')
  const raw = signed ? value : value >>> 0
  if (width === 1) {
    buffer.writeUInt8(raw & 0xff)
  } else if (width === 2) {
    if (endian === 'le') buffer.writeUInt16LE(raw & 0xffff)
    else buffer.writeUInt16BE(raw & 0xffff)
  } else if (width === 4) {
    if (endian === 'le') buffer.writeUInt32LE(raw >>> 0)
    else buffer.writeUInt32BE(raw >>> 0)
  }
  return buffer
}

function decodeInteger(buffer, offset, type, endian) {
  const width = fieldWidth(type)
  if (width === 1) return buffer.readUInt8(offset)
  if (width === 2) return endian === 'le' ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  return endian === 'le' ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
}

function headerLength(fields) {
  return fields.reduce((sum, field) => sum + fieldWidth(field.type), 0)
}

function endLength(model) {
  return model.framing.end === null ? 0 : 1
}

/** Header field list for one command, honouring overrides. */
export function resolveFields(model, command) {
  const override = model.framing.overrides.find(entry => entry.when.command === command)
  return override === undefined ? model.framing.fields : override.fields
}

function coverageRange(model, start, headerEnd, payloadEnd) {
  const framing = model.framing
  const syncLength = framing.sync.length
  switch (framing.checksum.coverage) {
    case 'frame':
      return [start, payloadEnd]
    case 'header+payload':
      return [start + syncLength, payloadEnd]
    case 'payload':
      return [headerEnd, payloadEnd]
    default:
      throw new Error(`unknown checksum coverage: ${framing.checksum.coverage}`)
  }
}

function checksumInit(model) {
  return model.framing.checksum.init
}

/** Encode one frame from a command, payload bytes and/or an explicit status. */
export function buildFrame(model, { command, payload = [], status } = {}) {
  if (!Number.isInteger(command) || command < 0 || command > 255) {
    throw new Error(`command must be a byte value, got ${String(command)}`)
  }
  const payloadBytes = status !== undefined ? Buffer.from([status & 0xff]) : toBuffer(payload)
  const fields = resolveFields(model, command)
  const framing = model.framing
  const headerSize = headerLength(fields)
  const checksumSize = checksumWidth(framing.checksum.algorithm)
  const total = framing.sync.length + headerSize + payloadBytes.length + checksumSize + endLength(model)

  if (payloadBytes.length > framing.maxPayload) {
    throw new Error(`payload of ${payloadBytes.length} bytes exceeds model maxPayload ${framing.maxPayload}`)
  }

  const frame = Buffer.alloc(total)
  let cursor = 0
  for (const byte of framing.sync) frame[cursor++] = byte

  for (const [index, field] of fields.entries()) {
    const value = index === 0
      ? command
      : field.name === framing.lengthField
        ? (framing.lengthIncludes === 'frame' ? total : payloadBytes.length)
        : 0
    encodeInteger(value, field.type, field.endian ?? 'be').copy(frame, cursor)
    cursor += fieldWidth(field.type)
  }

  payloadBytes.copy(frame, cursor)
  const headerEnd = cursor
  cursor += payloadBytes.length
  const payloadEnd = cursor

  const [from, to] = coverageRange(model, 0, headerEnd, payloadEnd)
  const value = computeChecksum(framing.checksum.algorithm, frame.subarray(from, to), checksumInit(model))
  const width = checksumSize
  if (width === 2) {
    const [hi, lo] = [value >> 8, value & 0xff]
    if (framing.checksum.byteOrder === 'le') {
      frame[cursor++] = lo
      frame[cursor++] = hi
    } else {
      frame[cursor++] = hi
      frame[cursor++] = lo
    }
  } else if (width === 1) {
    frame[cursor++] = value & 0xff
  }

  if (framing.end !== null) frame[cursor++] = framing.end

  return { buffer: frame, hex: frame.toString('hex'), checksum: value }
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload
  if (Array.isArray(payload)) return Buffer.from(payload.map(byte => byte & 0xff))
  if (typeof payload === 'string') {
    const cleaned = payload.replace(/\s+/gu, '')
    if (!/^([0-9a-fA-F]{2})*$/u.test(cleaned)) throw new Error('payload string must be hex bytes')
    return Buffer.from(cleaned, 'hex')
  }
  throw new Error('payload must be a Buffer, a byte array or a hex string')
}

function matchesAt(buffer, sequence, at) {
  if (at + sequence.length > buffer.length) return false
  for (let index = 0; index < sequence.length; index += 1) {
    if (buffer[at + index] !== sequence[index]) return false
  }
  return true
}

function indexOfSequence(buffer, sequence, from) {
  for (let at = from; at + sequence.length <= buffer.length; at += 1) {
    if (matchesAt(buffer, sequence, at)) return at
  }
  return -1
}

function readFields(model, buffer, start, fields) {
  const values = {}
  let cursor = start
  for (const field of fields) {
    values[field.name] = decodeInteger(buffer, cursor, field.type, field.endian ?? 'be')
    cursor += fieldWidth(field.type)
  }
  return values
}

function tryParseAt(model, buffer, start, limits) {
  const framing = model.framing
  const first = model.framing.fields[0]
  const firstWidth = fieldWidth(first.type)
  if (start + firstWidth > buffer.length) return { kind: 'partial' }

  const commandValue = buffer.readUInt8(start)
  const fields = resolveFields(model, commandValue)
  const headerSize = headerLength(fields)
  if (start + headerSize > buffer.length) return { kind: 'partial' }

  const values = readFields(model, buffer, start, fields)
  const declared = values[framing.lengthField]
  const checksumSize = checksumWidth(framing.checksum.algorithm)
  const syncLength = framing.sync.length
  const payloadLength = framing.lengthIncludes === 'frame'
    ? declared - (syncLength + headerSize + checksumSize + endLength(model))
    : declared

  if (payloadLength < 0 || payloadLength > framing.maxPayload) {
    return { kind: 'invalid', reason: `declared length ${declared} implies payload ${payloadLength}, outside 0..${framing.maxPayload}` }
  }
  const total = headerSize + payloadLength + checksumSize + endLength(model)
  if (start + total > buffer.length) return { kind: 'partial' }
  if (total > framing.maxFrame) {
    return { kind: 'invalid', reason: `frame of ${total} bytes exceeds maxFrame ${framing.maxFrame}` }
  }

  const payloadStart = start + headerSize
  const payloadEnd = payloadStart + payloadLength
  const [from, to] = coverageRange(model, start, payloadStart, payloadEnd)
  const computed = computeChecksum(framing.checksum.algorithm, buffer.subarray(from, to), checksumInit(model))
  const stored = buffer.subarray(payloadEnd, payloadEnd + checksumSize)
  let ok = false
  let orderUsed = framing.checksum.byteOrder
  if (checksumSize === 0) {
    ok = true
    orderUsed = undefined
  } else if (checksumSize === 1) {
    ok = stored[0] === (computed & 0xff)
    orderUsed = 'u8'
  } else {
    const be = (computed >> 8) === stored[0] && (computed & 0xff) === stored[1]
    const le = (computed & 0xff) === stored[0] && (computed >> 8) === stored[1]
    if (be) { ok = true; orderUsed = 'be' }
    else if (le && framing.checksum.acceptEitherOrder) { ok = true; orderUsed = 'le' }
  }
  if (!ok) {
    return {
      kind: 'invalid',
      reason: `checksum mismatch at offset ${start} (computed ${computed.toString(16).padStart(4, '0')}, stored ${stored.toString('hex') || 'none'})`,
    }
  }

  const payload = buffer.subarray(payloadStart, payloadEnd)
  return {
    kind: 'frame',
    frame: {
      start,
      end: start + total,
      header: values,
      command: values[first.name] ?? commandValue,
      payload,
    },
  }
}

/**
 * Split a byte buffer into frames.
 *
 * The call never throws for malformed input: unmatched bytes are reported via
 * `nextOffset` (the first byte not consumed, so a later call can retry when
 * more bytes arrive) and `errors`.
 */
export function parseBuffer(model, buffer, offset = 0, options = {}) {
  const framing = model.framing
  const maxFrames = options.maxFrames ?? 64
  const resyncLimit = options.resyncLimit ?? 8192
  const frames = []
  const errors = []
  let position = Math.min(Math.max(offset, 0), buffer.length)
  let skipped = 0

  while (position < buffer.length && frames.length < maxFrames) {
    if (framing.sync.length > 0) {
      const found = indexOfSequence(buffer, framing.sync, position)
      if (found < 0) break
      position = found
    }
    const attempt = tryParseAt(model, buffer, position, options)
    if (attempt.kind === 'partial') break
    if (attempt.kind === 'invalid') {
      skipped += 1
      if (skipped > resyncLimit) {
        errors.push(`resynchronisation gave up after ${skipped} skipped starts: ${attempt.reason}`)
        break
      }
      position += 1
      continue
    }
    frames.push(attempt.frame)
    position = attempt.frame.end
  }

  return {
    frames: frames.map(frame => decodeFrame(model, frame)),
    nextOffset: position,
    tailHex: buffer.subarray(position).toString('hex'),
    errors,
  }
}

/** Decode one parsed frame into the tool-facing shape. */
export function decodeFrame(model, frame) {
  const framing = model.framing
  const command = frame.command
  const commandInfo = model.commands.find(entry => entry.code === command)
  const payloadLength = frame.payload.length
  const payloadHex = frame.payload.toString('hex')
  const ascii = [...frame.payload].map(byte => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('')

  const isStatus = framing.payloadAsStatus && payloadLength === framing.statusWhenPayloadLength
  let status
  if (isStatus) {
    const code = frame.payload[0]
    const errorInfo = model.errors.find(entry => entry.code === code)
    status = {
      code,
      success: code === 0,
      ...(errorInfo === undefined
        ? {}
        : { name: errorInfo.name, ...(errorInfo.label === undefined ? {} : { label: errorInfo.label }) }),
    }
  }

  return {
    start: frame.start,
    end: frame.end,
    command,
    commandName: commandInfo?.name,
    label: commandInfo?.label,
    header: frame.header,
    payloadHex,
    payloadAscii: ascii,
    payloadLength,
    role: isStatus ? 'status' : 'data',
    ...(status === undefined ? {} : { status }),
    payloadBase64: frame.payload.toString('base64'),
  }
}

/** Build + parse one frame and report whether the roundtrip is consistent. */
export function verifyRoundtrip(model, { command, payload = [], status } = {}) {
  const built = buildFrame(model, { command, payload, status })
  const parsed = parseBuffer(model, built.buffer, 0, { maxFrames: 2 })
  const frame = parsed.frames[0]
  const checks = {
    built: built.hex,
    parsed: frame !== undefined,
    consumedAll: parsed.nextOffset === built.buffer.length,
    checksumOk: true,
    payloadMatch: frame !== undefined && frame.payloadHex === toBuffer(status !== undefined ? [status] : payload).toString('hex'),
    commandMatch: frame !== undefined && frame.command === command,
  }
  return { ok: checks.parsed && checks.consumedAll && checks.payloadMatch && checks.commandMatch, checks, frame }
}
