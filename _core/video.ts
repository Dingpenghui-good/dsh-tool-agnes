/**
 * Agnes AI video client: task creation plus the polling state machine.
 *
 * The gateway's polling payload is the fragile part of this integration, so it
 * is normalized in exactly one place:
 *
 * - `status` is absent on the earliest polls, while `internal_status` is
 *   always present; either may be the first to flip.
 * - `completed_at` becoming non-null is the authoritative completion signal.
 * - the finished video URL is a TOP-LEVEL `url`; `metadata.url` is a legacy
 *   location that older revisions of this integration read and never found.
 * - transient transport failures are normal on multi-minute polls and must not
 *   abandon a task that is still rendering.
 *
 * @module dsh-tool-agnes/core/video
 */

import { AgnesApiError, AgnesNetworkError } from './errors.ts'
import { AGNES_BASE_URL, AGNES_ROOT_URL, agnesJson, downloadBytes, sleep } from './http.ts'
import type { AgnesVideoCreateResponse, AgnesVideoPollResponse } from './types.ts'

/** Video model identifiers currently served by the Agnes gateway. */
export const VIDEO_MODELS = [
  'agnes-video-v2.0',
  'agnes-video-2.5',
  'agnes-video-2.5-flash',
  'agnes-video-2.5-fast',
] as const

/** One selectable video model id. */
export type VideoModel = (typeof VIDEO_MODELS)[number]

/**
 * The default video model.
 *
 * `agnes-video-2.5-flash` is the newest generation and sits on the free tier
 * (verified live: a free key creates and renders a task). `agnes-video-v2.0`
 * stays selectable for callers that want the legacy request shape or the
 * unrestricted `size` values.
 */
export const DEFAULT_VIDEO_MODEL = 'agnes-video-2.5-flash'

/**
 * Whether a model belongs to the 2.5 family, which uses the newer request
 * shape (`seconds`/`mode`/`size`/`aspect_ratio`) and requires `model_name` on
 * the polling endpoint.
 * @param model - model id.
 * @returns true for the 2.5 family.
 */
export function isVideo25Family(model: string): boolean {
  return model.startsWith('agnes-video-2.5')
}

/**
 * Size presets each family accepts.
 *
 * The 2.5 Flash model pins `size` to `720P`; the other 2.5 models and V2.0 take
 * a wider set, so the enforcement is reported to the model rather than guessed.
 * @param model - model id.
 * @returns the accepted size presets for that model.
 */
export function videoSizesFor(model: string): readonly string[] {
  if (model === 'agnes-video-2.5-flash') return ['720P']
  if (isVideo25Family(model)) return ['720P', '1080P', '1K', '2K']
  return ['720P', '1080P', '1K', '2K']
}

/** Largest frame count the V2.0 model accepts (`8n+1` with n = 55). */
export const MAX_VIDEO_FRAMES = 441

/**
 * Calculate the frame count the V2.0 model accepts, following its `8n+1` rule.
 *
 * The nearest valid count is used rather than rounding down, so an 8-second
 * request at 24fps yields 193 frames (8.04s) instead of 185 (7.71s).
 *
 * @param durationSeconds - requested duration.
 * @param frameRate - requested frame rate.
 * @returns a frame count of the form `8n+1`, at least 1 and at most {@link MAX_VIDEO_FRAMES}.
 */
export function calculateNumFrames(durationSeconds: number, frameRate: number): number {
  const target = Math.floor(durationSeconds * frameRate)
  const n = Math.round((target - 1) / 8)
  return Math.min(Math.max(8 * n + 1, 1), MAX_VIDEO_FRAMES)
}

/** Arguments common to both task-creation shapes. */
export interface CreateVideoTaskRequest {
  /** Bearer API key. */
  apiKey: string
  /** Video model id. */
  model: string
  /** Text prompt; optional for pure image animation on the 2.5 family. */
  prompt?: string
  /** Input image URL for image-to-video. */
  imageUrl?: string
  /** Requested duration in seconds (2.5 family only). */
  seconds?: string
  /** Requested video size. */
  size?: string
  /** Requested aspect ratio (2.5 family only). */
  aspectRatio?: string
  /** Explicit frame count (V2.0 only). */
  numFrames?: number
  /** Frame rate (V2.0 only). */
  frameRate?: number
  /** Explicit width in pixels (V2.0 only). */
  width?: number
  /** Explicit height in pixels (V2.0 only). */
  height?: number
  /** Reproducibility seed. */
  seed?: number
  /** Negative prompt. */
  negativePrompt?: string
  /** Caller cancellation. */
  signal: AbortSignal
}

/**
 * Build the provider request body for one task.
 *
 * The two families disagree about how an input image is expressed, verified
 * against the live gateway:
 *
 * - V2.0 takes a single `image` string alongside `width`/`height`/`num_frames`.
 * - The 2.5 family requires `mode`, and image input is the `reference` mode
 *   carrying an `images` ARRAY. Sending `mode: "image"` or a bare `image` field
 *   is rejected with `invalid mode`.
 *
 * @param request - the plugin-level request.
 * @returns the JSON body the gateway expects for this model family.
 */
function videoRequestBody(request: CreateVideoTaskRequest): Record<string, unknown> {
  const hasImage = request.imageUrl !== undefined && request.imageUrl.length > 0
  const body: Record<string, unknown> = { model: request.model }
  if (request.prompt !== undefined && request.prompt.length > 0) body.prompt = request.prompt
  if (request.seed !== undefined) body.seed = request.seed
  if (request.negativePrompt !== undefined && request.negativePrompt.length > 0) {
    body.negative_prompt = request.negativePrompt
  }

  if (isVideo25Family(request.model)) {
    body.mode = hasImage ? 'reference' : 'text'
    if (hasImage) body.images = [request.imageUrl]
    if (request.seconds !== undefined) body.seconds = request.seconds
    body.size = request.size ?? '720P'
    body.aspect_ratio = request.aspectRatio ?? '16:9'
  } else {
    if (hasImage) body.image = request.imageUrl
    body.width = request.width ?? 1920
    body.height = request.height ?? 1080
    body.num_frames = request.numFrames ?? calculateNumFrames(24, 24)
    body.frame_rate = request.frameRate ?? 24
  }
  return body
}

/**
 * Create one video task.
 * @param request - model, prompt, shape, and cancellation.
 * @returns the query handle and task identity.
 * @throws AgnesApiError on a non-2xx response.
 */
export async function createVideoTask(request: CreateVideoTaskRequest): Promise<{
  videoId: string
  taskId: string
  created: AgnesVideoCreateResponse
}> {
  const created = await agnesJson<AgnesVideoCreateResponse>({
    apiKey: request.apiKey,
    url: `${AGNES_BASE_URL}/videos`,
    body: videoRequestBody(request),
    signal: request.signal,
    timeoutMs: 180_000,
  })

  const videoId = created.video_id
  if (videoId === undefined || videoId.length === 0) {
    throw new Error(`Agnes created no video task: ${JSON.stringify(created).slice(0, 300)}`)
  }
  return { videoId, taskId: String(created.task_id ?? created.id ?? videoId), created }
}

/** Normalized lifecycle state of one video task. */
export type VideoTaskState = 'queued' | 'processing' | 'completed' | 'failed'

/**
 * Normalize one polling payload into a lifecycle state.
 *
 * `completed_at` and `error` win over the status strings because they are the
 * only fields the gateway keeps consistent across the whole lifecycle.
 *
 * @param payload - parsed polling response.
 * @returns the normalized state.
 */
export function normalizeVideoState(payload: AgnesVideoPollResponse): VideoTaskState {
  if (payload.error !== null && payload.error !== undefined) return 'failed'
  if (payload.completed_at !== null && payload.completed_at !== undefined) return 'completed'
  const explicit = (payload.status ?? payload.internal_status ?? '').toLowerCase()
  if (explicit === 'completed' || explicit === 'succeeded' || explicit === 'success') return 'completed'
  if (explicit === 'failed' || explicit === 'error' || explicit === 'cancelled') return 'failed'
  if (explicit === 'queued' || explicit === 'pending' || explicit === 'created') return 'queued'
  return 'processing'
}

/**
 * Extract the finished video URL, preferring the current top-level field.
 * @param payload - parsed polling response.
 * @returns the URL, or undefined while the task is unfinished.
 */
export function videoUrlOf(payload: AgnesVideoPollResponse): string | undefined {
  for (const candidate of [payload.url, payload.metadata?.url]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Render the provider's error field, which is a string or an envelope.
 * @param error - the payload's `error` field.
 * @returns a human-readable message, or undefined when absent.
 */
function errorMessageOf(error: AgnesVideoPollResponse['error']): string | undefined {
  if (error === null || error === undefined) return undefined
  if (typeof error === 'string') return error
  return error.message ?? JSON.stringify(error)
}

/** One normalized polling observation. */
export interface VideoPollResult {
  /** Normalized state. */
  state: VideoTaskState
  /** Completion percentage, 0-100. */
  progress: number
  /** Download URL, present once the task completes. */
  url?: string
  /** Failure reason, present once the task fails. */
  errorMessage?: string
  /** Effective duration in seconds, as reported by the gateway. */
  seconds?: string
  /** Effective pixel size, as reported by the gateway. */
  size?: string
  /** Provider note when it snapped the requested size to a supported preset. */
  sizeAdjustment?: string
}

/**
 * Turn one payload into a normalized observation.
 * @param payload - parsed polling response.
 * @param previous - the previous observation, used to carry progress forward.
 * @returns the normalized observation.
 */
function toPollResult(payload: AgnesVideoPollResponse, previous: VideoPollResult): VideoPollResult {
  const url = videoUrlOf(payload)
  const errorMessage = errorMessageOf(payload.error)
  return {
    state: normalizeVideoState(payload),
    progress: Math.round(payload.progress ?? payload.internal_progress ?? previous.progress),
    ...(url !== undefined ? { url } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(payload.seconds !== undefined ? { seconds: payload.seconds } : {}),
    ...(payload.size !== undefined ? { size: payload.size } : {}),
    ...(payload.size_mapping?.message !== undefined ? { sizeAdjustment: payload.size_mapping.message } : {}),
  }
}

/** Polling policy. */
export interface PollOptions {
  /** Delay between polls in milliseconds. */
  intervalMs: number
  /** Overall budget in milliseconds. */
  timeoutMs: number
  /** Consecutive transport failures tolerated before giving up. */
  maxConsecutiveFailures: number
  /** Progress callback, invoked on every observation. */
  onProgress?: (result: VideoPollResult) => void
}

/**
 * Read one task's current state without waiting.
 * @param apiKey - bearer API key.
 * @param videoId - query handle returned by {@link createVideoTask}.
 * @param model - model id; the 2.5 family requires it on the query string.
 * @param signal - caller cancellation.
 * @returns the normalized observation.
 */
export async function pollVideoTaskOnce(
  apiKey: string,
  videoId: string,
  model: string,
  signal: AbortSignal,
): Promise<VideoPollResult> {
  const query = new URLSearchParams({ video_id: videoId })
  if (isVideo25Family(model)) query.set('model_name', model)
  const payload = await agnesJson<AgnesVideoPollResponse>({
    apiKey,
    url: `${AGNES_ROOT_URL}/agnesapi?${query.toString()}`,
    method: 'GET',
    signal,
    timeoutMs: 60_000,
  })
  return toPollResult(payload, { state: 'queued', progress: 0 })
}

/**
 * Poll one video task until it settles.
 *
 * Transient transport errors are retried: a several-minute poll over a public
 * gateway will occasionally fail a request, and abandoning a task that is
 * still rendering would waste the whole generation.
 *
 * @param apiKey - bearer API key.
 * @param videoId - query handle returned by {@link createVideoTask}.
 * @param model - model id; the 2.5 family requires it on the query string.
 * @param options - polling policy.
 * @param signal - caller cancellation.
 * @returns the terminal observation.
 * @throws Error when the budget expires without a terminal state.
 */
export async function awaitVideoTask(
  apiKey: string,
  videoId: string,
  model: string,
  options: PollOptions,
  signal: AbortSignal,
): Promise<VideoPollResult> {
  const started = Date.now()
  let consecutiveFailures = 0
  let last: VideoPollResult = { state: 'queued', progress: 0 }

  for (;;) {
    if (signal.aborted) throw new AgnesNetworkError(new Error('aborted'), true)
    if (Date.now() - started > options.timeoutMs) {
      throw new Error(
        `video task ${videoId} did not finish within ${Math.round(options.timeoutMs / 1000)}s `
        + `(last state: ${last.state}, ${last.progress}%). Raise timeoutMs in the plugin config, `
        + 'or reduce the clip duration.',
      )
    }

    await sleep(options.intervalMs, signal)

    try {
      last = await pollVideoTaskOnce(apiKey, videoId, model, signal)
      consecutiveFailures = 0
    } catch (error) {
      if (signal.aborted) throw error
      // Rate limiting and auth failures will not fix themselves by retrying.
      if (error instanceof AgnesApiError && !error.retryable) throw error
      consecutiveFailures++
      if (consecutiveFailures > options.maxConsecutiveFailures) throw error
      continue
    }

    options.onProgress?.(last)
    if (last.state === 'completed' || last.state === 'failed') return last
  }
}

/**
 * Download a finished video.
 * @param url - provider download URL.
 * @param signal - caller cancellation.
 * @param timeoutMs - download budget; video files are megabytes.
 * @returns the video bytes.
 */
export async function fetchVideoBytes(
  url: string,
  signal: AbortSignal,
  timeoutMs = 300_000,
): Promise<Uint8Array> {
  return downloadBytes(url, signal, timeoutMs)
}
