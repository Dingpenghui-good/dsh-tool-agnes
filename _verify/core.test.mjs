/**
 * Unit tests for the shared Agnes core.
 *
 * Zero dependencies: Node's built-in test runner over the TypeScript sources
 * (Node 22+ strips types natively). Every payload below is a real observation
 * captured from the live Agnes gateway.
 *
 *   node --test _verify/core.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const video = await import(new URL('../_core/video.ts', import.meta.url).href)
const media = await import(new URL('../_core/media.ts', import.meta.url).href)
const errors = await import(new URL('../_core/errors.ts', import.meta.url).href)

const { normalizeVideoState, videoUrlOf, calculateNumFrames, isVideo25Family, MAX_VIDEO_FRAMES } = video
const { sniffImageMediaType, looksLikeMp4, formatBytes, toDataUrl } = media
const { AgnesApiError, AgnesNetworkError, AgnesMalformedResponseError, describeFailure } = errors

const EARLY_POLL = {
  completed_at: null, error: null, id: 'video_c6a6cf0a9ea44a8d9a82812a4a6b9ff2',
  internal_progress: 30, internal_status: 'inference', progress: 30, size: '1920x1088',
}
const DONE_POLL = {
  completed_at: 1789129626, error: null, internal_progress: 100, internal_status: 'completed',
  progress: 100, status: 'completed', seconds: '8.0', size: '1920x1088',
  url: 'https://cos-platform-outputs.agnes-ai.cn/videos/agnes-video-v2.0/clip.mp4',
  size_mapping: { message: 'Input size 1920x1080 was mapped to nearest preset 1080p/16:9 (1920x1088)' },
}

test('the polling state machine survives every real payload shape', () => {
  // The earliest polls carry no `status` at all — only `internal_status`.
  assert.equal(normalizeVideoState(EARLY_POLL), 'processing')
  assert.equal(normalizeVideoState({ ...EARLY_POLL, status: 'in_progress' }), 'processing')
  assert.equal(normalizeVideoState({ ...EARLY_POLL, status: 'queued' }), 'queued')
  assert.equal(normalizeVideoState(DONE_POLL), 'completed')
  assert.equal(normalizeVideoState({ ...EARLY_POLL, status: 'failed' }), 'failed')
  assert.equal(normalizeVideoState({ ...EARLY_POLL, error: { message: 'boom' } }), 'failed')
  // completed_at is authoritative even if a stale status still says otherwise.
  assert.equal(normalizeVideoState({ ...EARLY_POLL, completed_at: 1 }), 'completed')
})

test('the finished video URL is read from the top-level field, and the legacy one still works', () => {
  assert.equal(videoUrlOf(DONE_POLL), DONE_POLL.url)
  assert.equal(videoUrlOf({ ...DONE_POLL, url: null, metadata: { url: 'https://legacy/x.mp4' } }), 'https://legacy/x.mp4')
  assert.equal(videoUrlOf(EARLY_POLL), undefined)
})

test('frame counts follow the 8n+1 rule at its nearest value', () => {
  assert.equal(calculateNumFrames(8, 24), 193)
  assert.equal(calculateNumFrames(5, 24), 121)
  assert.equal(calculateNumFrames(60, 24), MAX_VIDEO_FRAMES)
  for (const duration of [1, 2, 3, 5, 8, 12, 18]) {
    assert.equal((calculateNumFrames(duration, 24) - 1) % 8, 0, `${duration}s must yield 8n+1 frames`)
  }
})

test('model families are told apart', () => {
  assert.ok(isVideo25Family('agnes-video-2.5'))
  assert.ok(isVideo25Family('agnes-video-2.5-flash'))
  assert.ok(!isVideo25Family('agnes-video-v2.0'))
})

test('raster formats are detected from magic bytes', () => {
  assert.equal(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])), 'image/png')
  assert.equal(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(sniffImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
  assert.throws(() => sniffImageMediaType(new Uint8Array([1, 2, 3, 4])))
})

test('video bytes are recognized as ISO BMFF', () => {
  assert.ok(looksLikeMp4(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])))
  assert.ok(!looksLikeMp4(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
})

test('every HTTP failure is classified and carries advice', () => {
  const cases = [
    [401, {}, 'auth'],
    [403, {}, 'forbidden'],
    [429, {}, 'rate-limit'],
    [500, {}, 'server'],
    [503, {}, 'server'],
    [400, { message: 'stream is not supported by text image queue' }, 'unsupported-field'],
    [400, { message: 'images is not supported by text image queue' }, 'unsupported-field'],
    [400, { message: 'format is not supported by text image queue' }, 'unsupported-field'],
    [400, { type: 'upstream_error', message: 'LLM Provider NOT provided' }, 'upstream'],
    [400, { message: 'n must be 1' }, 'invalid-request'],
  ]
  for (const [status, body, kind] of cases) {
    const error = new AgnesApiError(status, body, '')
    assert.equal(error.kind, kind, `${status} ${JSON.stringify(body)}`)
    assert.ok(error.advice.length > 20, `advice for ${kind}`)
  }
})

test('retryability is limited to transient server errors', () => {
  assert.equal(new AgnesApiError(429, {}, '').retryable, false)
  assert.equal(new AgnesApiError(401, {}, '').retryable, false)
  assert.equal(new AgnesApiError(400, { message: 'n must be 1' }, '').retryable, false)
  assert.equal(new AgnesApiError(503, {}, '').retryable, true)
})

test('failure descriptions pair the diagnosis with a next step', () => {
  const text = describeFailure(new AgnesApiError(429, {}, ''))
  assert.match(text, /Next step:/)
  assert.match(text, /Do not retry/)
  assert.match(describeFailure(new AgnesNetworkError(new Error('ECONNRESET'), false)), /Next step:/)
  assert.match(describeFailure(new AgnesMalformedResponseError('Agnes POST /v1/videos', 'oops')), /Next step:/)
  assert.equal(describeFailure(new Error('plain')), 'plain')
})

test('byte counts render compactly', () => {
  assert.equal(formatBytes(2_778_928), '2.65 MB')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(512), '512 B')
})

test('image bytes round-trip through a data URL', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const url = toDataUrl(bytes, 'image/jpeg')
  assert.ok(url.startsWith('data:image/jpeg;base64,'))
  const decoded = new Uint8Array(Buffer.from(url.split(',')[1], 'base64'))
  assert.deepEqual([...decoded], [...bytes])
})
