// Live test: Agnes text-to-image, without the now-rejected `stream` field.
import { readFileSync } from 'node:fs'
import { dshHome } from './fixtures.mjs'
import { homedir } from 'node:os'

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const BASE = 'https://apihub.agnes-ai.com/v1'
const JSON_AUTH = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

async function genImage(model, extra) {
  const body = { model, prompt: 'a red apple on a wooden table, soft studio light', ...extra }
  const t0 = Date.now()
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
  })
  const text = await res.text()
  console.log(`\n### model=${model} extra=${JSON.stringify(extra)} -> ${res.status} (${Date.now() - t0}ms)`)
  // Trim long base64 payloads for readability.
  console.log(text.replace(/"(b64_json|url)":"([^"]{120})[^"]*"/g, '"$1":"$2...<trimmed>"').slice(0, 2000))
  return text
}

await genImage('agnes-image-2.5-flash', {})
await genImage('agnes-image-2.5-flash', { size: '2K', ratio: '16:9' })
await genImage('agnes-image-2.1-flash', { size: '1K', ratio: '1:1' })
