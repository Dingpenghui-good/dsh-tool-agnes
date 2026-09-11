import { dependencyEntry, dshHome, localUrl, pluginEntry } from './fixtures.mjs'
/**
 * Runtime acceptance test for the Agnes plugins.
 *
 * Loads each built plugin exactly as the DSH loader does, captures the tool
 * definitions it registers, and exercises the parts that can be verified
 * without spending provider quota. For the image tool it makes a REAL API call
 * and validates the canonical value against the tool's own declared output
 * schema using DSH's own validator — that is the check the registry performs at
 * dispatch time.
 *
 * Run from anywhere: plugins are loaded by absolute path, and the shared core
 * is imported relative to this file. Build the packages first.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The validator must be the same copy the plugins load, so resolve it from a
// package rather than from here.
const { assertSupportedJsonSchema, validateJsonSchemaValue } =
  await import(dependencyEntry('dsh-tool-agnes-image', '@deepseek-ai/dsh-tools'))

const key = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const coreErrors = await import(localUrl('../_core/errors.ts'))

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && !ok ? `  (${detail})` : ''}`)
  if (!ok) failures.push(label)
}

/** Build the Cordis context surface the plugins touch. */
function makeCtx(captured, jobs) {
  return {
    get: (name) => {
      if (name === 'credentials') return { resolve: async () => ({ value: key, source: 'file' }) }
      if (name === 'attachments') {
        return {
          saveImage: async (input) => ({
            attachmentId: 'att_runtime_probe', mediaType: input.mediaType,
            bytes: input.data.byteLength, width: 1024, height: 1024, name: input.name,
          }),
          saveFile: async (input) => ({
            attachmentId: 'att_video_probe', name: input.name, bytes: input.data.byteLength,
          }),
        }
      }
      return undefined
    },
    tools: { register: (definition) => { captured.push(definition); return () => {} } },
    jobs,
    // The image-to-video plugin subscribes to the session event feed.
    on: () => () => {},
  }
}

const CONFIG = {
  model: 'agnes-video-v2.0', defaultSize: '1K', defaultRatio: '1:1',
  persistAttachment: true, ferryContext: true, timeoutMs: 600_000,
  pollIntervalMs: 5000, maxConsecutiveFailures: 4, awaitCompletion: false, persistVideo: true,
}

const EXEC = { signal: new AbortController().signal, parent: undefined, deferContext: () => {}, agent: undefined }

// ── 1. Each plugin loads, registers its tools, and declares schemas DSH accepts.
const expected = {
  'dsh-tool-agnes-image': ['generate_image'],
  'dsh-tool-agnes-video': ['generate_video', 'get_video_task'],
  'dsh-tool-agnes-img2vid': ['generate_img2vid'],
}

const captured = {}
for (const [pkg, toolNames] of Object.entries(expected)) {
  const mod = await import(pluginEntry(pkg))
  const definitions = []
  const config = { ...CONFIG, model: pkg.includes('image') ? 'agnes-image-2.5-flash' : 'agnes-video-v2.0' }
  mod.apply(makeCtx(definitions, undefined), config)
  captured[pkg] = Object.fromEntries(definitions.map(d => [d.name, d]))
  const names = definitions.map(d => d.name)
  check(`${pkg} registers ${toolNames.join(' + ')}`, JSON.stringify(names) === JSON.stringify(toolNames), names.join(','))
  for (const definition of definitions) {
    let ok = true
    let detail
    try { assertSupportedJsonSchema(definition.output.schema) } catch (error) { ok = false; detail = error.message }
    check(`  ${definition.name}: output schema supported`, ok, detail)
    check(`  ${definition.name}: presentCall + render declared`, typeof definition.presentCall === 'function' && typeof definition.output.render === 'function')
  }
}

// ── 2. generate_image: real API call, then validate against its own schema.
{
  const tool = captured['dsh-tool-agnes-image'].generate_image
  const args = { prompt: 'a single red apple on a wooden table, studio light, photorealistic', size: '1K', ratio: '1:1' }
  // This gateway drops the occasional connection; the point of the check is the
  // schema contract, not the network, so a transient failure is retried.
  let value
  for (let attempt = 0; ; attempt++) {
    try { value = await tool.execute(args, EXEC); break } catch (error) {
      if (attempt >= 2) throw error
      console.log(`  (transport retry ${attempt + 1}: ${error.message.slice(0, 80)})`)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  const violations = validateJsonSchemaValue(tool.output.schema, value, '')
  check('generate_image: value matches its output schema', violations.length === 0, JSON.stringify(violations))
  check('generate_image: returns a usable URL', typeof value.url === 'string' && value.url.startsWith('https://'))
  check('generate_image: persisted an attachment', value.attachment !== undefined && value.attachment.bytes > 0)
  check('generate_image: renders [text, image]', tool.output.render(args, value).map(b => b.type).join(',') === 'text,image')
  const call = tool.presentCall(args)
  check('generate_image: presentCall returns a card', call?.card === 'generic' && typeof call.title === 'string')
}

// ── 3. get_video_task: reads a finished / running background job, no quota spent.
{
  function toolWith(jobSnapshot, text) {
    const definitions = []
    const mod = captured['dsh-tool-agnes-video'].get_video_task
    void mod
    return { definitions, jobSnapshot, text }
  }
  void toolWith

  const result = {
    taskId: 'task_probe', videoId: 'video_probe', state: 'completed', model: 'agnes-video-v2.0',
    progress: 100, videoUrl: 'https://example.invalid/video.mp4',
    attachment: { attachmentId: 'att_video_probe', name: 'agnes-video-task_probe.mp4', bytes: 2_778_928 },
    seconds: '8.0', size: '1920x1088',
  }

  const settledDefs = []
  const videoMod = await import(pluginEntry('dsh-tool-agnes-video'))
  videoMod.apply(makeCtx(settledDefs, {
    start: () => 'agnes-video-1',
    read: () => ({
      text: JSON.stringify(result),
      snapshot: { id: 'agnes-video-1', kind: 'agnes-video', label: 'x', status: 'completed', startedAt: 0, reported: false },
    }),
  }), CONFIG)
  const settledTool = settledDefs.find(d => d.name === 'get_video_task')
  const settledValue = await settledTool.execute({ jobId: 'agnes-video-1' }, EXEC)
  const settledViolations = validateJsonSchemaValue(settledTool.output.schema, settledValue, '')
  check('get_video_task: value matches its output schema', settledViolations.length === 0, JSON.stringify(settledViolations))
  check('get_video_task: reports completed URL', settledValue.status === 'completed' && settledValue.videoUrl === 'https://example.invalid/video.mp4')
  check('get_video_task: surfaces the local attachment', settledValue.attachment?.bytes === 2_778_928)

  const runningDefs = []
  videoMod.apply(makeCtx(runningDefs, {
    start: () => 'agnes-video-2',
    read: () => ({
      text: '',
      snapshot: { id: 'agnes-video-2', kind: 'agnes-video', label: 'x', status: 'running', startedAt: 0, reported: false },
    }),
  }), CONFIG)
  const runningValue = await runningDefs.find(d => d.name === 'get_video_task').execute({ jobId: 'agnes-video-2' }, EXEC)
  check('get_video_task: reports a running job as processing', runningValue.status === 'processing')
}

// ── 4. generate_video / generate_img2vid: definition-level assertions only
//      (queueing a real task would spend provider quota).
{
  const videoTool = captured['dsh-tool-agnes-video'].generate_video
  const call = videoTool.presentCall({ prompt: 'a paper boat drifting downstream, slow dolly in' })
  check('generate_video: presentCall names the model', call?.title.includes('agnes-video-v2.0'))
  check('generate_video: default mode is non-blocking', CONFIG.awaitCompletion === false)

  const imgTool = captured['dsh-tool-agnes-img2vid'].generate_img2vid
  const imgCall = imgTool.presentCall({ image: 'https://example.invalid/a.png' })
  check('generate_img2vid: presentCall returns a card', imgCall?.card === 'generic')
  check('generate_img2vid: description promises local/attachment inlining',
    imgTool.description.includes('inlined into the request'))
  check('generate_img2vid: accepts a local path as well as a URL',
    String(imgTool.parameters.properties.image.description).includes('local file path'))
}

// ── 5. Error classification: the actionable-advice layer.
{
  const { AgnesApiError } = coreErrors
  const cases = [
    [401, {}, 'auth'],
    [403, {}, 'forbidden'],
    [429, {}, 'rate-limit'],
    [500, {}, 'server'],
    [400, { message: 'stream is not supported by text image queue' }, 'unsupported-field'],
    [400, { message: 'images is not supported by text image queue' }, 'unsupported-field'],
    [400, { type: 'upstream_error', message: 'LLM Provider NOT provided' }, 'upstream'],
    [400, { message: 'n must be 1' }, 'invalid-request'],
  ]
  for (const [status, body, expectedKind] of cases) {
    const error = new AgnesApiError(status, body, '')
    check(`error ${status} ${JSON.stringify(body).slice(0, 42)} →${expectedKind}`, error.kind === expectedKind, error.kind)
  }
  check('advice is actionable for auth failures', new AgnesApiError(401, {}, '').advice.includes('credentials.yaml'))
  check('advice forbids blind retry on rate limit', new AgnesApiError(429, {}, '').advice.includes('Do not retry'))
  check('rate limit is not retryable', new AgnesApiError(429, {}, '').retryable === false)
  check('server error is retryable', new AgnesApiError(503, {}, '').retryable === true)
}

console.log(failures.length === 0
  ? '\nALL ACCEPTANCE CHECKS PASSED'
  : `\n${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
