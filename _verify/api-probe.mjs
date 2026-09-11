// Comprehensive probe of the Agnes AI API surface as currently published.
import { readFileSync } from 'node:fs'
import { dshHome } from './fixtures.mjs'
import { homedir } from 'node:os'

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]
if (!key) throw new Error('AGNES_AI_API_KEY not found')

const BASE = 'https://apihub.agnes-ai.com/v1'
const AUTH = { Authorization: `Bearer ${key}` }
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' }

async function get(path, base = BASE) {
  const t0 = Date.now()
  const res = await fetch(`${base}${path}`, { headers: AUTH, signal: AbortSignal.timeout(40_000) })
  const text = await res.text()
  console.log(`\n### GET ${path} -> ${res.status} (${Date.now() - t0}ms)`)
  console.log(text.slice(0, 2500))
  return text
}

async function post(path, body) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  })
  const text = await res.text()
  console.log(`\n### POST ${path} ${JSON.stringify(body)} -> ${res.status} (${Date.now() - t0}ms)`)
  console.log(text.slice(0, 2500))
  return text
}

await get('/models')
