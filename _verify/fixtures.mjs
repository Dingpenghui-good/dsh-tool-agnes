/**
 * Shared helpers for the verification scripts.
 *
 * Everything here resolves paths portably (no machine-specific absolutes) and
 * generates its own test image, so a fresh clone can run the suite as-is.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

/**
 * The DSH home directory: `$DSH_HOME`, else `~/.dsh`.
 * @returns an absolute directory path.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Read the Agnes API key from the DSH credentials file.
 * @returns the bearer token.
 * @throws Error when the file or the key is missing.
 */
export function readKey() {
  const path = join(dshHome(), '.credentials.yaml')
  if (!existsSync(path)) {
    throw new Error(`no credentials file at ${path}; set DSH_HOME or create it with an AGNES_AI_API_KEY ref`)
  }
  const match = readFileSync(path, 'utf8').match(/AGNES_AI_API_KEY:\s*(\S+)/)
  if (match === null) throw new Error(`AGNES_AI_API_KEY not found in ${path}`)
  return match[1]
}

/**
 * Absolute URL of a file next to this one, for importing TypeScript sources.
 * @param relative - path relative to `_verify/`.
 * @returns a `file://` URL string.
 */
export function localUrl(relative) {
  return new URL(relative, import.meta.url).href
}

/**
 * The plugin repository root (the directory holding `_core/` and the packages).
 * @returns an absolute directory path.
 */
export function repoRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/**
 * Absolute import URL of one built plugin.
 *
 * Loading the package by path (rather than by its bare `@dingpenghui/…` name)
 * is what lets these scripts run from anywhere: a bare specifier would have to
 * resolve from this file's own location, which is outside the DSH profile that
 * links the plugins. The entry is the built `lib/index.js`, and its own
 * `@deepseek-ai/*` imports resolve from the package's `node_modules`.
 *
 * @param directory - the package directory, e.g. `dsh-tool-agnes-image`.
 * @returns a `file://` URL string.
 */
export function pluginEntry(directory) {
  const entry = join(repoRoot(), directory, 'lib', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`no build at ${entry}; run \`pnpm install && pnpm build\` in ${directory} first`)
  }
  return pathToFileURL(entry).href
}

/**
 * Import URL of a dependency resolved from inside one package.
 *
 * The harness packages a plugin depends on live in that package's own
 * `node_modules` (a pnpm link), so resolving them from here is the portable way
 * to reach the same copy the plugin loads.
 *
 * @param fromDirectory - package directory to resolve from.
 * @param specifier - dependency name, e.g. `@deepseek-ai/dsh-tools`.
 * @returns a `file://` URL string.
 */
export function dependencyEntry(fromDirectory, specifier) {
  const require = createRequire(pathToFileURL(join(repoRoot(), fromDirectory, 'package.json')))
  return pathToFileURL(require.resolve(specifier)).href
}

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/**
 * CRC-32 of a buffer, as PNG requires.
 * @param buffer - the bytes.
 * @returns the unsigned checksum.
 */
function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * Build one PNG chunk with its length and CRC.
 * @param type - four-character chunk type.
 * @param data - chunk payload.
 * @returns the encoded chunk.
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/**
 * Generate a small, valid PNG without any image library.
 *
 * The verification scripts need a real raster (the provider decodes it), and
 * committing a fixture photo to a public repository is undesirable — so they
 * build one instead.
 *
 * @param width - image width in pixels.
 * @param height - image height in pixels.
 * @returns the encoded PNG bytes.
 */
export function makeTestPng(width = 64, height = 64) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8   // bit depth
  header[9] = 2   // colour type: truecolour
  // bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0   // filter type: none
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3
      raw[pixel] = (x * 255 / width) & 0xff
      raw[pixel + 1] = (y * 255 / height) & 0xff
      raw[pixel + 2] = 160
    }
  }

  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]))
}
