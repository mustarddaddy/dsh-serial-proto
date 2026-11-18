// Smoke test for the protocol-aware serial panel: model load, frame build, frame parse.
// Usage: node test/smoke.mjs
import { fileURLToPath } from 'node:url'
import { loadModel } from '../lib/protocol/model.js'
import { buildFrame, parseBuffer } from '../lib/protocol/frame.js'

// Defaults to the bundled fixture so the test runs on a clean clone;
// pass a project directory and model name to run it against a real model.
const dir = process.argv[2] ?? fileURLToPath(new URL('./fixtures/project/', import.meta.url))
const name = process.argv[3] ?? 'demo'

const loaded = loadModel(dir, name)
if (!loaded.found) {
  console.error(`model not found: ${dir}/.dsh/protocols/${name}.json`)
  process.exit(1)
}
const model = loaded.model
console.log(`model: ${model.name} baud=${model.transport.baudRate} fields=${model.framing.fields.map(f => `${f.name}:${f.type}`).join(',')}`)
console.log(`diagnostics: ${loaded.diagnostics.join(' | ') || 'none'}`)

let failures = 0
const checks = []
const check = (label, ok, detail) => {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

for (const command of model.commands) {
  const request = buildFrame(model, { command: command.code, payload: [], status: undefined })
  const parsed = parseBuffer(model, request.buffer)
  check(
    `request 0x${command.code.toString(16).padStart(2, '0')} ${command.name ?? ''}`.trim(),
    parsed.frames.length === 1 && parsed.frames[0].command === command.code,
    request.hex,
  )

  const status = buildFrame(model, { command: command.code, payload: [], status: 0 })
  const parsedStatus = parseBuffer(model, status.buffer)
  const frame = parsedStatus.frames[0]
  check(
    `status  0x${command.code.toString(16).padStart(2, '0')} ${command.name ?? ''}`.trim(),
    parsedStatus.frames.length === 1 && frame.role === 'status' && frame.status?.code === 0,
  )
}

const override = model.framing.overrides?.[0]
if (override !== undefined) {
  const command = override.when.command
  const payload = Array.from({ length: 300 }, (_, i) => i & 0xff)
  const built = buildFrame(model, { command, payload })
  const parsed = parseBuffer(model, built.buffer)
  check(
    `override 0x${command.toString(16).padStart(2, '0')} 300-byte payload`,
    parsed.frames.length === 1 && parsed.frames[0].payloadLength === payload.length,
    built.hex.slice(0, 16) + '…',
  )
}

// Bytes captured from the firmware: 0x0A request and its success status reply.
const sample = Buffer.from('0a0010070a01005250', 'hex')
const parsedSample = parseBuffer(model, sample)
check('captured sample decodes two frames', parsedSample.frames.length === 2, String(parsedSample.frames.length))
if (parsedSample.frames.length === 2) {
  check('captured sample status frame', parsedSample.frames[1].status?.code === 0, JSON.stringify(parsedSample.frames[1].status))
}

for (const line of checks) console.log(line)
console.log(failures === 0 ? 'smoke: ok' : `smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
