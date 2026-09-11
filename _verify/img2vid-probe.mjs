// Verify image-to-video really works: mint a public image, then create a V2.0 video task from it.
import { readFileSync } from 'node:fs'
import { dshHome } from './fixtures.mjs'
import { homedir } from 'node:os'

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const BASE = 'https://apihub.agnes-ai.com/v1'
const JSON_AUTH = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

// 1. Mint a public source image.
const seedRes = await fetch(`${BASE}/images/generations`, {
  method: 'POST', headers: JSON_AUTH,
  body: JSON.stringify({
    model: 'agnes-image-2.5-flash',
    prompt: 'a small wooden sailboat on calm turquoise water, wide shot, clear sky',
    size: '1K', ratio: '16:9',
  }),
  signal: AbortSignal.timeout(240_000),
})
const seed = await seedRes.json()
const imageUrl = seed?.data?.[0]?.url
console.log('seed image:', imageUrl ?? '(none)')
if (!imageUrl) process.exit(1)

await new Promise(r => setTimeout(r, 4000))

// 2. Create an image-to-video task with the V2.0 request shape used by the plugin.
const createRes = await fetch(`${BASE}/videos`, {
  method: 'POST', headers: JSON_AUTH,
  body: JSON.stringify({
    model: 'agnes-video-v2.0',
    image: imageUrl,
    prompt: 'the sailboat drifts slowly forward, gentle ripples, static camera',
    width: 1280, height: 720, num_frames: 97, frame_rate: 24,
  }),
  signal: AbortSignal.timeout(180_000),
})
const text = await createRes.text()
console.log(`\nPOST /videos (image-to-video) -> ${createRes.status}`)
console.log(text.slice(0, 900))

let videoId
try { videoId = JSON.parse(text).video_id } catch { /* ignore */ }
if (!videoId) { console.log('\nno video_id; image-to-video creation failed'); process.exit(1) }

// 3. Poll briefly — we only need to confirm the task was accepted and progresses.
const ROOT = 'https://apihub.agnes-ai.com'
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const res = await fetch(`${ROOT}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000),
  })
  const body = await res.text()
  let parsed
  try { parsed = JSON.parse(body) } catch { console.log(`poll ${i}: non-JSON`); continue }
  console.log(`poll ${i}: status=${parsed.status ?? '-'} internal=${parsed.internal_status ?? '-'} progress=${parsed.progress ?? '-'} mode=${parsed.request_params?.mode ?? '-'} image=${parsed.request_params?.image ? 'set' : 'null'}`)
  if (parsed.completed_at) { console.log('completed; url =', parsed.url); break }
  if (parsed.error) { console.log('failed:', JSON.stringify(parsed.error)); break }
}
