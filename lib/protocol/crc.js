/**
 * Checksum primitives used by the protocol engine.
 *
 * Only well-known algorithms are implemented: they can be named in a protocol
 * model, and each one is checked against a published test vector in the tests.
 */

function reflect8(value) {
  let out = 0
  for (let bit = 0; bit < 8; bit += 1) {
    if ((value >>> bit) & 1) out |= 1 << (7 - bit)
  }
  return out & 0xff
}

function reflect16(value) {
  let out = 0
  for (let bit = 0; bit < 16; bit += 1) {
    if ((value >>> bit) & 1) out |= 1 << (15 - bit)
  }
  return out & 0xffff
}

/**
 * CRC-16/ARC (a.k.a. CRC-16/MODBUS with init 0xFFFF): reflected polynomial
 * 0xA001, refin/refout true, xorout 0.
 *
 * This is the algorithm hotstamp's `CrcCal()` implements, so it is the default
 * the scanner proposes when it sees `MULTINOMIAL 0xa001`.
 */
export function crc16Modbus(bytes, init = 0xffff) {
  let crc = init & 0xffff
  for (const byte of bytes) {
    crc ^= byte & 0xff
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) & 0xffff : (crc >>> 1) & 0xffff
    }
  }
  return crc & 0xffff
}

/** CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF, not reflected. */
export function crc16CcittFalse(bytes, init = 0xffff) {
  let crc = init & 0xffff
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

/** CRC-16/XMODEM: polynomial 0x1021, init 0, not reflected. */
export function crc16Xmodem(bytes, init = 0) {
  let crc = init & 0xffff
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

/** CRC-16/IBM (a.k.a. CRC-16/ARC with init 0). */
export function crc16Ibm(bytes, init = 0) {
  return crc16Modbus(bytes, init)
}

/** CRC-8/ATM (poly 0x07, init 0), occasionally used for short frames. */
export function crc8Atm(bytes, init = 0) {
  let crc = init & 0xff
  for (const byte of bytes) {
    crc ^= byte & 0xff
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
    }
  }
  return crc & 0xff
}

const ALGORITHMS = new Map([
  ['crc16-modbus', { width: 2, fn: crc16Modbus }],
  ['crc16-arc', { width: 2, fn: crc16Modbus }],
  ['crc16-ccitt-false', { width: 2, fn: crc16CcittFalse }],
  ['crc16-xmodem', { width: 2, fn: crc16Xmodem }],
  ['crc16-ibm', { width: 2, fn: crc16Ibm }],
  ['crc16', { width: 2, fn: crc16Modbus }],
  ['crc8-atm', { width: 1, fn: crc8Atm }],
  ['none', { width: 0, fn: () => 0 }],
])

/** Ordered list used by schema validation and the scanner. */
export const CHECKSUM_ALGORITHMS = [...ALGORITHMS.keys()]

/** Width in bytes of a checksum algorithm (0 for `none`). */
export function checksumWidth(algorithm) {
  const entry = ALGORITHMS.get(algorithm)
  if (entry === undefined) throw new Error(`unknown checksum algorithm: ${algorithm}`)
  return entry.width
}

/**
 * Compute a named checksum.
 *
 * @param algorithm - a name from CHECKSUM_ALGORITHMS.
 * @param bytes - payload the checksum covers.
 * @param init - initial register value; omitted means the algorithm default.
 */
export function computeChecksum(algorithm, bytes, init) {
  const entry = ALGORITHMS.get(algorithm)
  if (entry === undefined) throw new Error(`unknown checksum algorithm: ${algorithm}`)
  return init === undefined ? entry.fn(bytes) : entry.fn(bytes, init)
}

export { reflect8, reflect16 }
