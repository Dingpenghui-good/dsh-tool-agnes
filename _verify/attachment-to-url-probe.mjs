import { dshHome, makeTestPng } from './fixtures.mjs'
import { homedir } from 'node:os'
/**
 * Can an image that lives ONLY in DSH (no public URL) drive Agnes image-to-video?
 *
 * Tests, cheapest first:
 *   1. Does the gateway expose an OpenAI-style /v1/files upload endpoint?
 *   2. Does POST /v1/videos accept a data: URL in `image`?
 *   3. Does it accept a bare base64 string?
 *
 * Any single "yes" removes the public-URL requirement entirely.
 */
import { readFileSync } from 'node:fs'

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const BASE = 'https://apihub.agnes-ai.com/v1'
const AUTH = { Authorization: `Bearer ${key}` }
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' }

const bytes = readFileSync(join(tmpdir(), 'agnes-fixture.png'))
const b64 = bytes.toString('base64')
console.log(`source image: ${bytes.length} bytes -> base64 ${b64.length} chars`)

async function step(label, fn) {
  try {
    const { status, text } = await fn()
    console.log(`\n### ${label} -> ${status}`)
    console.log(text.slice(0, 700))
    return { status, text }
  } catch (error) {
    console.log(`\n### ${label} -> TRANSPORT ${error?.message}`)
    return { status: 0, text: '' }
  }
}

// ── 1. Is there a files endpoint at all?
await step('GET /v1/files (exists?)', async () => {
  const res = await fetch(`${BASE}/files`, { headers: AUTH, signal: AbortSignal.timeout(40_000) })
  return { status: res.status, text: await res.text() }
})

await new Promise(r => setTimeout(r, 2000))

// ── 1b. Multipart upload, if the endpoint exists.
await step('POST /v1/files (multipart)', async () => {
  const form = new FormData()
  form.append('purpose', 'vision')
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'probe.jpg')
  const res = await fetch(`${BASE}/files`, {
    method: 'POST', headers: AUTH, body: form, signal: AbortSignal.timeout(90_000),
  })
  return { status: res.status, text: await res.text() }
})

await new Promise(r => setTimeout(r, 3000))

// ── 2. data: URL in `image`.
await step('POST /v1/videos with data: URL (422 KB body)', async () => {
  const res = await fetch(`${BASE}/videos`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({
      model: 'agnes-video-v2.0',
      image: `data:image/jpeg;base64,${b64}`,
      prompt: 'the duck turns its head slightly, static camera',
      width: 1280, height: 720, num_frames: 97, frame_rate: 24,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  return { status: res.status, text: await res.text() }
})
