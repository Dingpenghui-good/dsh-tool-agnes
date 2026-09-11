import { dshHome, localUrl, makeTestPng } from './fixtures.mjs'
/**
 * Verify that an image which exists only on this machine can drive
 * Agnes image-to-video.
 *
 * Part 1 exercises the resolver for every source kind.
 * Part 2 really creates a video task from a LOCAL file (no public URL), which
 * is the end-to-end proof that the public-URL requirement is gone.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const source = await import(localUrl('../_core/image-source.ts'))
const { resolveImageSource } = source

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && !ok ? `  (${detail})` : ''}`)
  if (!ok) failures.push(label)
}

// A real file on disk, generated here so the suite needs no committed fixture.
const LOCAL_PNG = join(tmpdir(), 'agnes-fixture.png')
writeFileSync(LOCAL_PNG, makeTestPng(256, 256))

// ── 1. Source resolution.
const remote = await resolveImageSource('https://example.com/a.png', { maxInlineBytes: 8 << 20 })
check('http URL passes through untouched', remote.kind === 'remote-url' && remote.value === 'https://example.com/a.png')

const inline = await resolveImageSource('data:image/png;base64,AAAA', { maxInlineBytes: 8 << 20 })
check('data URL passes through untouched', inline.kind === 'inline' && inline.value.startsWith('data:image/png'))

const local = await resolveImageSource(LOCAL_PNG, { maxInlineBytes: 8 << 20 })
check('local file path is inlined', local.kind === 'inline' && local.value.startsWith('data:image/png;base64,'))
check('local file inlining reports its byte count', local.inlinedBytes === readFileSync(LOCAL_PNG).byteLength)
check('local file inlining round-trips the bytes',
  Buffer.from(local.value.split(',')[1], 'base64').equals(readFileSync(LOCAL_PNG)))

// A real DSH attachment, located through the content-addressed store.
const objectsRoot = join(dshHome(), 'attachments', 'v1', 'objects')
let attachmentId
for (const prefix of readdirSync(objectsRoot)) {
  const dir = join(objectsRoot, prefix)
  const entries = readdirSync(dir)
  if (entries.length > 0) { attachmentId = entries[0]; break }
}
if (attachmentId !== undefined) {
  const fromAttachment = await resolveImageSource(`attachment:${attachmentId}`, { maxInlineBytes: 16 << 20 })
  check(`attachment:${attachmentId.slice(0, 12)}… is inlined`, fromAttachment.kind === 'inline' && fromAttachment.value.startsWith('data:image/'))
} else {
  check('an attachment exists to test', false, 'no objects found')
}

// Failure modes must be clear and must not reach the provider.
let missingPathError
try { await resolveImageSource('E:\\nope\\missing.png', { maxInlineBytes: 8 << 20 }) } catch (error) { missingPathError = error.message }
check('a missing file fails before any provider call', typeof missingPathError === 'string' && missingPathError.includes('could not read an image'))

let oversizeError
try { await resolveImageSource(LOCAL_PNG, { maxInlineBytes: 1024 }) } catch (error) { oversizeError = error.message }
check('an oversize image is refused with guidance', typeof oversizeError === 'string' && oversizeError.includes('inlining limit'))

let badAttachment
try { await resolveImageSource('attachment:zzz', { maxInlineBytes: 8 << 20 }) } catch (error) { badAttachment = error.message }
check('a malformed attachment id is rejected', typeof badAttachment === 'string' && badAttachment.includes('not a valid attachment id'))

// ── 2. End-to-end: a LOCAL file drives a real video task.
const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

// The gateway drops the occasional connection; retry so a flake does not read
// as a contract failure.
let res
let text = ''
for (let attempt = 0; ; attempt++) {
  try {
    res = await fetch('https://apihub.agnes-ai.com/v1/videos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'agnes-video-v2.0',
        image: local.value,               // <-- inline data URL from a local file
        prompt: 'the scene slowly brightens, static camera',
        width: 1280, height: 720, num_frames: 97, frame_rate: 24,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    text = await res.text()
    break
  } catch (error) {
    if (attempt >= 2) throw error
    console.log(`  (transport retry ${attempt + 1}: ${error.message.slice(0, 60)})`)
    await new Promise(r => setTimeout(r, 4000))
  }
}
check('a LOCAL image (data URL) creates a real video task', res.status === 200, `${res.status} ${text.slice(0, 200)}`)
let videoId
try { videoId = JSON.parse(text).video_id } catch { /* ignore */ }
check('the task returned a video_id', typeof videoId === 'string' && videoId.length > 0)

console.log(failures.length === 0 ? '\nALL IMAGE-SOURCE CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
