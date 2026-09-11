import { dshHome, makeTestPng, pluginEntry } from './fixtures.mjs'
/**
 * Verify that an image the user pasted in the GUI can drive image-to-video
 * WITHOUT the model ever knowing its attachment id.
 *
 * The model receives the picture's pixels but never its `attachmentId`, so it
 * cannot name the image. The plugin therefore indexes images from the session
 * event feed, and `generate_img2vid` resolves "latest" itself.
 *
 * Part 1 exercises the index and the resolution path with a mocked session.
 * Part 2 really creates a video task from a session-supplied image.
 */
import { readFileSync } from 'node:fs'

const profile = dshHome()
const key = readFileSync(`${profile}\\.credentials.yaml`, 'utf8')
  .match(/AGNES_AI_API_KEY:\s*(\S+)/)?.[1]

const failures = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && !ok ? `  (${detail})` : ''}`)
  if (!ok) failures.push(label)
}

// A realistic pasted-image payload: real raster bytes behind a durable reference.
const IMAGE_BYTES = makeTestPng(256, 256)
const REF = {
  attachmentId: 'a'.repeat(64),
  mediaType: 'image/png',
  bytes: IMAGE_BYTES.byteLength,
  width: 256,
  height: 256,
}
const SESSION_ID = 'session-paste-test'

/** Build a Cordis-like context, capturing the session listener. */
function makeCtx(definitions, jobs, subscriptions) {
  return {
    get: (name) => {
      if (name === 'credentials') return { resolve: async () => ({ value: key, source: 'file' }) }
      if (name === 'attachments') {
        return {
          readImage: async (ref) => {
            if (String(ref.attachmentId) !== String(REF.attachmentId)) throw new Error('unknown attachment')
            return { ref, data: IMAGE_BYTES }
          },
          saveFile: async (input) => ({ attachmentId: 'att_video', name: input.name, bytes: input.data.byteLength }),
        }
      }
      return undefined
    },
    tools: { register: (definition) => { definitions.push(definition); return () => {} } },
    jobs,
    on: (event, listener) => { subscriptions.push({ event, listener }); return () => {} },
  }
}

function loadedPlugin(subscriptions) {
  return import(pluginEntry('dsh-tool-agnes-img2vid')).then((mod) => {
    const definitions = []
    mod.apply(makeCtx(definitions, { start: () => 'agnes-video-9' }, subscriptions), {
      model: 'agnes-video-v2.0', pollIntervalMs: 5000, timeoutMs: 900_000,
      maxConsecutiveFailures: 4, ferryContext: true, awaitCompletion: true,
      persistVideo: true, maxInlineImageBytes: 8 << 20,
    })
    return definitions.find(d => d.name === 'generate_img2vid')
  })
}

const EXEC = { signal: new AbortController().signal, parent: undefined, deferContext: () => {}, agent: { id: SESSION_ID } }

// ── 1. Before any image arrives, the tool must refuse with guidance.
{
  const subs = []
  const tool = await loadedPlugin(subs)
  check('the plugin subscribes to the session event feed',
    subs.some(s => s.event === 'session/event'), JSON.stringify(subs.map(s => s.event)))
  let error
  try { await tool.execute({ prompt: 'x' }, EXEC) } catch (caught) { error = caught.message }
  check('omitting image with no session image fails with guidance',
    typeof error === 'string' && error.includes('Paste or upload an image'), error)
}

// ── 2. A pasted image becomes resolvable without the model naming it.
{
  const subs = []
  const tool = await loadedPlugin(subs)
  const feed = subs.find(s => s.event === 'session/event').listener

  // What DSH emits when the user pastes a picture into the chat.
  feed({ id: SESSION_ID }, { type: 'user/message', data: { content: [{ type: 'image', attachment: REF }] } })

  // A message with no image must not disturb the window.
  feed({ id: SESSION_ID }, { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } })
  // Another session's image must not leak across sessions.
  feed({ id: 'other-session' }, { type: 'user/message', data: { content: [{ type: 'image', attachment: { ...REF, attachmentId: 'b'.repeat(64) } }] } })

  const value = await tool.execute({ prompt: 'the duck turns its head, static camera', duration: 4 }, EXEC)
  check('the pasted image is resolved to an attachment reference',
    value.image === `attachment:${REF.attachmentId}`, value.image)
  check('the pasted image is inlined into the request', value.imageResolution === 'inline', value.imageResolution)
  check('a real provider task was created from the session image',
    typeof value.taskId === 'string' && value.taskId.length > 0, value.taskId)
}

// ── 3. The aliases behave, and an explicit source still wins.
{
  const subs = []
  const tool = await loadedPlugin(subs)
  subs.find(s => s.event === 'session/event').listener(
    { id: SESSION_ID }, { type: 'user/message', data: { content: [{ type: 'image', attachment: REF }] } },
  )
  const value = await tool.execute({ image: 'latest', prompt: 'x', duration: 4 }, EXEC)
  check('the alias "latest" means the session image', value.image === `attachment:${REF.attachmentId}`)

  let explicit
  try { await tool.execute({ image: 'E:\\nope\\missing.png' }, EXEC) } catch (caught) { explicit = caught.message }
  check('an explicit unreadable source fails instead of falling back',
    typeof explicit === 'string' && explicit.includes('could not read an image'), explicit)
}

console.log(failures.length === 0 ? '\nALL SESSION-IMAGE CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
