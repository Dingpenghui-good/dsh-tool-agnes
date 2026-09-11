/**
 * Agnes AI image-to-video generation tool for DeepSeek Harness.
 *
 * Registers `generate_img2vid`, which animates a still image by creating an
 * Agnes video task whose first frame is that image. The render happens in the
 * background as a DSH job by default.
 *
 * The image reference is resolved by `_core/image-source.ts`, so a public URL,
 * a DSH attachment, a local file path, and an inline data URL are all usable —
 * only the first of which the provider could fetch by itself.
 *
 * The companion tool `get_video_task` (registered by
 * `@dingpenghui/agnes-video`) reads the result; without it, DSH's own
 * `job_output` tool can read the same job.
 *
 * @module @dingpenghui/agnes-img2vid
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readCredential } from '../../_core/credential.ts'
import { describeFailure } from '../../_core/errors.ts'
import { AGNES_BASE_URL } from '../../_core/http.ts'
import { resolveImageSource, inlineImageBytes } from '../../_core/image-source.ts'
import type { ImageSourceKind, ResolvedImageSource } from '../../_core/image-source.ts'
import { RecentImageIndex } from '../../_core/recent-images.ts'
import { formatBytes } from '../../_core/media.ts'
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODELS,
  awaitVideoTask,
  calculateNumFrames,
  createVideoTask,
  isVideo25Family,
} from '../../_core/video.ts'
import type { VideoTaskState } from '../../_core/video.ts'
import { startVideoJob } from '../../_core/video-job.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-agnes-img2vid'

/** Services required by the image-to-video plugin. */
export const inject = ['tools', 'jobs'] as const

/** Aspect ratios accepted by the 2.5 family. */
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const

/** Size presets accepted by the 2.5 family. */
const SIZES = ['720P', '1080P', '1K', '2K'] as const

/** Deployment configuration for the image-to-video tool. */
export interface Config {
  /** Default video model id. */
  model: string
  /** Delay between task polls, in milliseconds. */
  pollIntervalMs: number
  /** Overall budget for one generation, in milliseconds. */
  timeoutMs: number
  /** Consecutive transport failures tolerated while polling. */
  maxConsecutiveFailures: number
  /** Whether a nested dispatch (PTC sub-call) also ferries a synchronous result outward. */
  ferryContext: boolean
  /** Whether the call blocks until the clip is rendered. */
  awaitCompletion: boolean
  /** Whether a finished video is downloaded into the attachment store. */
  persistVideo: boolean
  /** Largest local image inlined into the request as a data URL. */
  maxInlineImageBytes: number
}

/** Schemastery configuration for the image-to-video tool. */
export const Config: z<Config> = z.object({
  model: z.string().default(DEFAULT_VIDEO_MODEL),
  pollIntervalMs: z.natural().default(5000),
  timeoutMs: z.natural().default(900_000),
  maxConsecutiveFailures: z.natural().default(4),
  ferryContext: z.boolean().default(true),
  awaitCompletion: z.boolean().default(false),
  persistVideo: z.boolean().default(true),
  maxInlineImageBytes: z.natural().default(8 * 1024 * 1024),
})

/** Model-facing argument shape of `generate_img2vid`. */
type GenerateImg2VidArgs = {
  image?: string
  prompt?: string
  model?: string
  duration?: number
  width?: number
  height?: number
  frameRate?: number
  size?: string
  aspectRatio?: string
  seed?: number
  negativePrompt?: string
}

/** Canonical value of `generate_img2vid`. */
interface GenerateImg2VidValue {
  taskId: string
  status: VideoTaskState
  image: string
  imageResolution: ImageSourceKind
  model: string
  text: string
  jobId?: string
  prompt?: string
  videoUrl?: string
  attachment?: { attachmentId: string; name: string; bytes: number }
  durationSeconds?: number
  progress?: number
  effectiveSeconds?: string
  effectiveSize?: string
  sizeAdjustment?: string
  errorMessage?: string
  persistError?: string
}

/** Model-facing argument schema of `generate_img2vid`. */
const PARAMETERS = {
  image: {
    type: 'string',
    description: 'Which image to animate. OMIT THIS (or pass "latest") to animate the most recent image the user pasted or uploaded in this conversation — that is the right choice for "animate this image" when the user just supplied one. Otherwise pass a public http(s) URL, a DSH attachment reference ("attachment:<id>"), a local file path, or an inline data: URL; local, attachment, and session images are inlined automatically.',
  },
  prompt: {
    type: 'string',
    description: 'Motion description: subject action, camera movement, atmosphere. English works best.',
  },
  model: {
    type: 'string',
    enum: [...VIDEO_MODELS],
    description: 'Video model. agnes-video-2.5-flash (the default) is the newest generation and is free; it takes duration/size/aspectRatio and pins size to "720P". agnes-video-v2.0 is the legacy shape and takes width/height/frameRate instead.',
  },
  duration: {
    type: 'integer',
    description: 'Target duration in seconds. V2.0 snaps to the nearest 8n+1 frame count; the 2.5 family takes whole seconds.',
  },
  width: { type: 'integer', description: 'Frame width in pixels (agnes-video-v2.0 only).' },
  height: { type: 'integer', description: 'Frame height in pixels (agnes-video-v2.0 only).' },
  frameRate: { type: 'integer', description: 'Frames per second (agnes-video-v2.0 only).' },
  size: { type: 'string', enum: [...SIZES], description: 'Size preset (2.5 family only).' },
  aspectRatio: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Aspect ratio (2.5 family only).' },
  seed: { type: 'integer', description: 'Seed for a reproducible result, when the model honours one.' },
  negativePrompt: { type: 'string', description: 'Concepts to avoid in the generated video.' },
} as const

/**
 * Render the model-visible summary for a queued animation.
 * @param value - the canonical result.
 * @returns the summary block.
 */
function renderQueued(value: GenerateImg2VidValue): string {
  return [
    '**Image animation started**',
    `- model: ${value.model}`,
    `- source image: ${value.image}${value.imageResolution === 'inline' ? ' (inlined)' : ''}`,
    `- task: ${value.taskId}`,
    `- job: ${value.jobId ?? '(not tracked)'}`,
    '',
    'The clip renders on the provider side and takes MINUTES. Call `get_video_task` with this job id to collect the result; do not start a duplicate generation while it runs.',
  ].join('\n')
}

/**
 * Render the model-visible summary of a terminal synchronous result.
 * @param value - the canonical result.
 * @returns the summary block.
 */
function renderImg2VidText(value: GenerateImg2VidValue): string {
  if (value.status === 'completed' && value.videoUrl !== undefined) {
    return [
      '**Image animated**',
      `- model: ${value.model}`,
      `- task: ${value.taskId}`,
      `- source image: ${value.image}`,
      value.prompt !== undefined ? `- prompt: ${value.prompt.slice(0, 120)}` : null,
      value.effectiveSize !== undefined ? `- size: ${value.effectiveSize}` : null,
      value.effectiveSeconds !== undefined ? `- duration: ${value.effectiveSeconds}s` : null,
      value.sizeAdjustment !== undefined ? `- note: ${value.sizeAdjustment}` : null,
      `- url: ${value.videoUrl}`,
      value.attachment !== undefined
        ? `- saved locally: ${value.attachment.name} (${formatBytes(value.attachment.bytes)})`
        : value.persistError !== undefined
          ? `- local copy not saved: ${value.persistError}`
          : null,
    ].filter((line): line is string => line !== null).join('\n')
  }
  if (value.status === 'failed') {
    return [
      '**Image animation failed**',
      `- task: ${value.taskId}`,
      `- model: ${value.model}`,
      `- source image: ${value.image}`,
      `- reason: ${value.errorMessage ?? 'unknown error'}`,
    ].join('\n')
  }
  return [
    '**Image animation still running**',
    `- task: ${value.taskId}`,
    `- state: ${value.status}${value.progress !== undefined ? ` (${value.progress}%)` : ''}`,
  ].join('\n')
}

/**
 * Resolve "the image the user just gave me" from the session image index.
 *
 * @param ctx - plugin context; must carry the `attachments` service.
 * @param index - the per-session image window.
 * @param exec - the running tool call, used for the session id and cancellation.
 * @param maxInlineBytes - inlining ceiling.
 * @returns the inline source and the reference to report back.
 * @throws Error when the session supplied no image, or the service is missing.
 */
async function resolveSessionImage(
  ctx: Context,
  index: RecentImageIndex,
  exec: ToolRunContext,
  maxInlineBytes: number,
): Promise<{ source: ResolvedImageSource; reference: string }> {
  const sessionId = exec.agent !== undefined ? String(exec.agent.id) : undefined
  const ref = index.latest(sessionId)
  if (ref === undefined) {
    throw new Error(
      'no image from this conversation is available to animate. Paste or upload an image in the chat first, '
      + 'or pass `image` a public URL, a local file path, or an attachment:<id>.',
    )
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error('the attachment service is unavailable, so the session image cannot be read')
  }
  const stored = await attachments.readImage(ref, exec.signal)
  const reference = `attachment:${String(ref.attachmentId)}`
  return {
    source: inlineImageBytes(stored.data, reference, { maxInlineBytes }),
    reference,
  }
}

/** Values of `image` that mean "whatever the user just gave me". */
const LATEST_ALIASES = new Set(['latest', 'recent', 'last', 'last-upload', 'this', 'attachment:latest'])

/**
 * Register the Agnes image-to-video tool.
 * @param ctx - plugin context.
 * @param config - resolved deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // The model never receives an attachment id for a picture the user pasted, so
  // the plugin remembers those images itself and resolves "latest" from here.
  const recentImages = new RecentImageIndex(ctx)
  recentImages.register()

  ctx.tools.register(defineTool({
    name: 'generate_img2vid',
    description: `Animate a still image into a video with the Agnes AI video model.
Use it when the user supplies an image and asks for it to move; use generate_video instead for a purely text-driven clip.
The image may be a public http(s) URL, a DSH attachment ("attachment:<id>", which is what generate_image returns), a local file path, or an inline data URL; local and attachment sources are inlined into the request automatically, so the image does not need to be hosted anywhere.
Describe the intended motion in the optional prompt (for example "hair drifting in the wind, slow push in") and prefer English.
${config.awaitCompletion
  ? `This call blocks until the clip is rendered or the ${Math.round(config.timeoutMs / 1000)}s budget expires.`
  : 'This call returns as soon as the task is queued; rendering continues in the background and the result is collected with get_video_task.'}

Endpoint: ${AGNES_BASE_URL}/videos · default model: ${config.model}`,
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true, description: 'Provider task id.' },
          status: {
            type: 'string',
            enum: ['queued', 'processing', 'completed', 'failed'],
            required: true,
            description: 'Current or terminal task state.',
          },
          image: { type: 'string', required: true, description: 'The image reference that was submitted.' },
          imageResolution: {
            type: 'string',
            enum: ['remote-url', 'inline'],
            required: true,
            description: 'Whether the provider fetched the image itself, or it was inlined into the request.',
          },
          model: { type: 'string', required: true, description: 'The model that was used.' },
          text: { type: 'string', required: true, description: 'Model-visible summary.' },
          jobId: { type: 'string', description: 'Background job id; pass it to get_video_task to collect the result.' },
          prompt: { type: 'string', description: 'The motion prompt, when one was submitted.' },
          videoUrl: { type: 'string', description: 'Download URL, once the task completed.' },
          attachment: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true, description: 'Durable attachment id.' },
              name: { type: 'string', required: true, description: 'Stored file name.' },
              bytes: { type: 'integer', required: true, description: 'Stored byte length.' },
            },
            description: 'Durable copy of the rendered video, when persistence succeeded.',
          },
          durationSeconds: { type: 'integer', description: 'Requested duration in seconds.' },
          progress: { type: 'integer', description: 'Last observed completion percentage.' },
          effectiveSeconds: { type: 'string', description: 'Duration reported by the provider.' },
          effectiveSize: { type: 'string', description: 'Pixel size reported by the provider.' },
          sizeAdjustment: { type: 'string', description: 'Provider note when it snapped the requested size to a preset.' },
          errorMessage: { type: 'string', description: 'Failure reason, when the task failed.' },
          persistError: { type: 'string', description: 'Why the local copy could not be written.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as GenerateImg2VidValue).text }],
    },
    presentCall: (args): ToolCallView => {
      const model = args.model ?? config.model
      return {
        card: 'generic',
        title: `Animate image · ${model}`,
        kind: 'other',
        rawInput: {
          image: args.image ?? '(most recent image in this conversation)',
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          duration: args.duration ?? 8,
        },
      }
    },
    presentResult: (_args, result): ToolResultView => ({
      card: 'generic',
      title: result.isError ? 'Image animation failed' : 'Image animation',
      content: result.content,
    }),
    async execute(args, exec) {
      const typed = args as GenerateImg2VidArgs
      const apiKey = await readCredential(ctx)
      const model = typed.model ?? config.model
      const duration = typed.duration ?? 8
      const frameRate = typed.frameRate ?? 24
      const family25 = isVideo25Family(model)

      // Resolve the image FIRST: an unreadable source must fail before a
      // provider task is created and billed.
      const requested = typed.image?.trim()
      const wantsLatest = requested === undefined
        || requested.length === 0
        || LATEST_ALIASES.has(requested.toLowerCase())
      const resolved = wantsLatest
        ? await resolveSessionImage(ctx, recentImages, exec, config.maxInlineImageBytes)
        : {
            source: await resolveImageSource(requested, { maxInlineBytes: config.maxInlineImageBytes }),
            reference: requested,
          }
      const source = resolved.source
      const imageReference = resolved.reference

      const created = await createVideoTask({
        apiKey,
        model,
        imageUrl: source.value,
        signal: exec.signal,
        ...(typed.prompt !== undefined ? { prompt: typed.prompt } : {}),
        ...(family25
          ? { seconds: String(duration), size: typed.size ?? '720P', aspectRatio: typed.aspectRatio ?? '16:9' }
          : {
              width: typed.width ?? 1920,
              height: typed.height ?? 1080,
              frameRate,
              numFrames: calculateNumFrames(duration, frameRate),
            }),
        ...(typed.seed !== undefined ? { seed: typed.seed } : {}),
        ...(typed.negativePrompt !== undefined ? { negativePrompt: typed.negativePrompt } : {}),
      })

      const pollOptions = {
        intervalMs: config.pollIntervalMs,
        timeoutMs: config.timeoutMs,
        maxConsecutiveFailures: config.maxConsecutiveFailures,
      }
      const common = {
        taskId: created.taskId,
        image: imageReference,
        imageResolution: source.kind,
        model,
        ...(typed.prompt !== undefined ? { prompt: typed.prompt } : {}),
        durationSeconds: duration,
      }

      if (config.awaitCompletion) {
        const settled = await awaitVideoTask(apiKey, created.videoId, model, pollOptions, exec.signal)
        const value: GenerateImg2VidValue = {
          ...common,
          status: settled.state,
          text: '',
          ...(settled.url !== undefined ? { videoUrl: settled.url } : {}),
          progress: settled.progress,
          ...(settled.seconds !== undefined ? { effectiveSeconds: settled.seconds } : {}),
          ...(settled.size !== undefined ? { effectiveSize: settled.size } : {}),
          ...(settled.sizeAdjustment !== undefined ? { sizeAdjustment: settled.sizeAdjustment } : {}),
          ...(settled.errorMessage !== undefined ? { errorMessage: settled.errorMessage } : {}),
        }
        value.text = renderImg2VidText(value)
        if (config.ferryContext && exec.parent !== undefined) {
          exec.deferContext(createUserMessage({
            content: [{ type: 'text', text: value.text }] as ContentBlock[],
            source: {
              kind: 'plugin',
              plugin: name,
              form: 'notice',
              summary: `image animation ${value.status}: ${imageReference.slice(0, 80)}`,
            },
          }))
        }
        return value
      }

      let jobId: string | undefined
      try {
        jobId = String(startVideoJob(ctx, exec.agent, {
          apiKey,
          videoId: created.videoId,
          taskId: created.taskId,
          model,
          label: `Agnes img2vid: ${imageReference.slice(-48)}`,
          pollOptions,
          persistVideo: config.persistVideo,
          imageUrl: imageReference,
          ...(typed.prompt !== undefined ? { prompt: typed.prompt } : {}),
        }))
      } catch (error) {
        const fallback: GenerateImg2VidValue = {
          ...common,
          status: 'queued',
          text: [
            '**Image animation started**',
            `- task: ${created.taskId}`,
            `- model: ${model}`,
            `- note: background jobs are unavailable here (${describeFailure(error)}), so the clip is not being tracked automatically.`,
          ].join('\n'),
        }
        return fallback
      }

      const queued: GenerateImg2VidValue = { ...common, status: 'queued', jobId, text: '' }
      queued.text = renderQueued(queued)
      return queued
    },
  }))
}
