// Probe which extended image/video capabilities the Agnes gateway accepts today.
import { readFileSync } from 'node:fs'
import { dshHome } from './fixtures.mjs'
import { homedir } from 'node:os'

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const BASE = 'https://apihub.agnes-ai.com/v1'
const JSON_AUTH = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

async function post(label, path, body, timeoutMs = 240_000) {
  const t0 = Date.now()
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    console.log(`\n### [${label}] -> ${res.status} (${Date.now() - t0}ms)`)
    console.log(text.replace(/"(b64_json|url)":"([^"]{90})[^"]*"/g, '"$1":"$2…"').slice(0, 900))
    return { status: res.status, text }
  } catch (err) {
    console.log(`\n### [${label}] -> TRANSPORT FAIL ${Date.now() - t0}ms ${err?.message}`)
    return { status: 0, text: '' }
  }
}

// Step 1: one plain generation, so we have a real public image URL to feed back in.
const seed = await post('seed image', '/images/generations', {
  model: 'agnes-image-2.5-flash',
  prompt: 'a white ceramic mug on a plain grey table, product photo',
  size: '1K', ratio: '1:1',
})
let imageUrl
try { imageUrl = JSON.parse(seed.text).data[0].url } catch { /* ignore */ }
console.log('\nseed image URL:', imageUrl ? `${imageUrl.slice(0, 80)}…` : '(none)')

if (!imageUrl) { console.log('no seed URL; aborting dependent probes'); process.exit(0) }

await new Promise(r => setTimeout(r, 3000))

// Step 2: image-to-image via a remote URL.
await post('img2img via url', '/images/generations', {
  model: 'agnes-image-2.5-flash',
  prompt: 'the same mug, now bright red, product photo',
  image: imageUrl,
  size: '1K', ratio: '1:1',
})

await new Promise(r => setTimeout(r, 3000))

// Step 3: an `images` array (multi-reference shape).
await post('img2img via images[]', '/images/generations', {
  model: 'agnes-image-2.5-flash',
  prompt: 'restyle this product photo as a watercolor painting',
  images: [imageUrl],
  size: '1K', ratio: '1:1',
})

await new Promise(r => setTimeout(r, 3000))

// Step 4: multiple outputs in one call.
await post('n=2', '/images/generations', {
  model: 'agnes-image-2.5-flash',
  prompt: 'a small blue paper crane, minimal white background',
  n: 2,
  size: '1K', ratio: '1:1',
})
