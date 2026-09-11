// Probe: video task creation shapes for both the legacy V2.0 and the 2.5 family.
import { readFileSync } from 'node:fs'
import { dshHome } from './fixtures.mjs'
import { homedir } from 'node:os'

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const BASE = 'https://apihub.agnes-ai.com/v1'
const ROOT = 'https://apihub.agnes-ai.com'
const JSON_AUTH = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const AUTH = { Authorization: `Bearer ${key}` }

async function create(label, body) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/videos`, {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  console.log(`\n### [${label}] POST /videos -> ${res.status} (${Date.now() - t0}ms)`)
  console.log(text.slice(0, 1200))
  return text
}

// Legacy V2.0 shape used by the current plugin.
await create('v2.0 legacy-shape', {
  model: 'agnes-video-v2.0',
  prompt: 'a cat napping in warm sunlight, static shot',
  width: 1920, height: 1080, num_frames: 193, frame_rate: 24,
})

// Modern 2.5-flash shape per the published docs.
await create('2.5-flash doc-shape', {
  model: 'agnes-video-2.5-flash',
  prompt: 'a cat napping in warm sunlight, static shot',
  seconds: '5',
  mode: 'text',
  size: '720P',
  aspect_ratio: '16:9',
})
