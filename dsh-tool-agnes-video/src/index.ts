/**
 * Agnes AI text-to-video generation tools for DeepSeek Harness.
 *
 * Registers two model-facing tools:
 *
 *  - `generate_video`  — creates an Agnes video task. By default it returns
 *                        immediately and renders in the background as a DSH
 *                        job, because a clip takes minutes to render.
 *  - `get_video_task`  — reads the structured result of such a job.
 *
 * @module @dingpenghui/agnes-video
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readCredential } from '../../_core/credential.ts'
import { describeFailure } from '../../_core/errors.ts'
import { AGNES_BASE_URL } from '../../_core/http.ts'
import { formatBytes } from '../../_core/media.ts'
import {
  VIDEO_MODELS,
  awaitVideoTask,
  calculateNumFrames,
  createVideoTask,
  isVideo25Family,
} from '../../_core/video.ts'
import type { VideoTaskState } from '../../_core/video.ts'
import { readVideoJob, startVideoJob } from '../../_core/video-job.ts'
import type { VideoJobResult } from '../../_core/video-job.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-agnes-video'

/** Services required by the video plugin. */
export const inject = ['tools', 'jobs'] as const

/** Aspect ratios accepted by the 2.5 family. */
const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const

/** Size presets accepted by the 2.5 family. */
const SIZES = ['720P', '1080P', '1K', '2K'] as const

/** Deployment configuration for the video tools. */
export interface Config {
  /** Default video model id. */
  model: string
  /** Delay between task polls, in milliseconds. */
  pollIntervalMs: number
  /** Overall budget for one generation, in milliseconds. */
  timeoutMs: number
  /** Consecutive transport failures tolerated while polling. */
  maxConsecutiveFailures: number
  /**
   * Whether a nested dispatch (PTC sub-call) also ferries a synchronous result
   * outward. Applies only when `awaitCompletion` is true.
   */
  ferryContext: boolean
  /**
   * Whether `generate_video` blocks until the clip is rendered. False (the
   * default) returns the task id immediately and renders as a DSH job.
   */
  awaitCompletion: boolean
  /** Whether a finished video is downloaded into the attachment store. */
  persistVideo: boolean
}

/** Schemastery configuration for the video tools. */
export const Config: z<Config> = z.object({
  model: z.string().default(VIDEO_MODELS[0]),
  pollIntervalMs: z.natural().default(5000),
  timeoutMs: z.natural().default(900_000),
  maxConsecutiveFailures: z.natural().default(4),
  ferryContext: z.boolean().default(true),
  awaitCompletion: z.boolean().default(false),
  persistVideo: z.boolean().default(true),
})

/** Model-facing argument shape of `generate_video`. */
type GenerateVideoArgs = {
  prompt: string
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

/** Canonical value of `generate_video`. */
interface GenerateVideoValue {
  taskId: string
  status: VideoTaskState
  model: string
  prompt: string
  text: string
  jobId?: string
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

/** Canonical value of `get_video_task`. */
interface GetVideoTaskValue {
  jobId: string
  status: VideoTaskState
  text: string
  taskId?: string
  model?: string
  progress?: number
  videoUrl?: string
  attachment?: { attachmentId: string; name: string; bytes: number }
  effectiveSeconds?: string
  effectiveSize?: string
  errorMessage?: string
  persistError?: string
}

/**
 * Render the model-visible summary for a queued or running task.
 * @param taskId - provider task id.
 * @param jobId - DSH job id.
 * @param model - the model in use.
 * @param prompt - the submitted prompt.
 * @returns the summary block.
 */
function renderQueued(taskId: string, jobId: string, model: string, prompt: string): string {
  return [
    '**Video generation started**',
    `- model: ${model}`,
    `- task: ${taskId}`,
    `- job: ${jobId}`,
    `- prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`,
    '',
    'The clip renders on the provider side and takes MINUTES. Call `get_video_task` with this job id to collect the result; do not start a duplicate generation while it runs.',
  ].join('\n')
}

/**
 * Render the model-visible summary of a terminal synchronous result.
 * @param value - the canonical result.
 * @returns the summary block.
 */
function renderVideoText(value: GenerateVideoValue): string {
  if (value.status === 'completed' && value.videoUrl !== undefined) {
    return [
      '**Video generated**',
      `- model: ${value.model}`,
      `- task: ${value.taskId}`,
      `- prompt: ${value.prompt.slice(0, 120)}${value.prompt.length > 120 ? '…' : ''}`,
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
      '**Video generation failed**',
      `- task: ${value.taskId}`,
      `- model: ${value.model}`,
      `- reason: ${value.errorMessage ?? 'unknown error'}`,
    ].join('\n')
  }
  return [
    '**Video generation still running**',
    `- task: ${value.taskId}`,
    `- state: ${value.status}${value.progress !== undefined ? ` (${value.progress}%)` : ''}`,
  ].join('\n')
}

/**
 * Register the Agnes video tools.
 * @param ctx - plugin context.
 * @param config - resolved deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'generate_video',
    description: `Generate a video from a text prompt with the Agnes AI video model.
Use it for motion, animation, and short cinematic clips. Do NOT use it to animate a still image the user supplied — that is generate_img2vid.
Include camera movement and subject action in the prompt (for example "slow dolly in", "static shot", "panning left") and prefer English.
${config.awaitCompletion
  ? `This call blocks until the clip is rendered or the ${Math.round(config.timeoutMs / 1000)}s budget expires.`
  : 'This call returns as soon as the task is queued; rendering continues in the background and the result is collected with get_video_task.'}

Endpoint: ${AGNES_BASE_URL}/videos · default model: ${config.model}`,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Video description including subject action, camera movement, lighting, and style. English works best.',
      },
      model: {
        type: 'string',
        enum: [...VIDEO_MODELS],
        default: config.model,
        description: 'Video model. agnes-video-v2.0 is free and accepts width/height/frameRate; the 2.5 family is billed per second and uses size/aspectRatio instead.',
      },
      duration: {
        type: 'integer',
        default: 8,
        description: 'Target duration in seconds. V2.0 snaps to the nearest 8n+1 frame count; the 2.5 family takes whole seconds.',
      },
      width: {
        type: 'integer',
        default: 1920,
        description: 'Frame width in pixels (agnes-video-v2.0 only). The provider snaps it to the nearest supported preset.',
      },
      height: {
        type: 'integer',
        default: 1080,
        description: 'Frame height in pixels (agnes-video-v2.0 only). The provider snaps it to the nearest supported preset.',
      },
      frameRate: {
        type: 'integer',
        default: 24,
        description: 'Frames per second (agnes-video-v2.0 only).',
      },
      size: {
        type: 'string',
        enum: [...SIZES],
        default: '720P',
        description: 'Size preset (2.5 family only).',
      },
      aspectRatio: {
        type: 'string',
        enum: [...ASPECT_RATIOS],
        default: '16:9',
        description: 'Aspect ratio (2.5 family only).',
      },
      seed: { type: 'integer', description: 'Seed for a reproducible result, when the model honours one.' },
      negativePrompt: { type: 'string', description: 'Concepts to avoid in the generated video.' },
    },
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
          model: { type: 'string', required: true, description: 'The model that was used.' },
          prompt: { type: 'string', required: true, description: 'The prompt that was submitted.' },
          text: { type: 'string', required: true, description: 'Model-visible summary.' },
          jobId: { type: 'string', description: 'Background job id; pass it to get_video_task to collect the result.' },
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
      render: (_args, value) => [{ type: 'text', text: (value as GenerateVideoValue).text }],
    },
    presentCall: (args): ToolCallView => {
      const model = args.model ?? config.model
      return {
        card: 'generic',
        title: `Generate video · ${model}`,
        kind: 'other',
        rawInput: {
          prompt: args.prompt,
          duration: args.duration ?? 8,
          ...(isVideo25Family(model)
            ? { size: args.size ?? '720P', aspectRatio: args.aspectRatio ?? '16:9' }
            : { width: args.width ?? 1920, height: args.height ?? 1080 }),
        },
      }
    },
    presentResult: (_args, result): ToolResultView => ({
      card: 'generic',
      title: result.isError ? 'Video generation failed' : 'Video generation',
      content: result.content,
    }),
    async execute(args, exec) {
      const typed = args as GenerateVideoArgs
      const apiKey = await readCredential(ctx)
      const model = typed.model ?? config.model
      const duration = typed.duration ?? 8
      const frameRate = typed.frameRate ?? 24
      const family25 = isVideo25Family(model)

      const created = await createVideoTask({
        apiKey,
        model,
        prompt: typed.prompt,
        signal: exec.signal,
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

      // ── Blocking mode: keep the whole render inside the tool call. ──────
      if (config.awaitCompletion) {
        const settled = await awaitVideoTask(apiKey, created.videoId, model, pollOptions, exec.signal)
        const value: GenerateVideoValue = {
          taskId: created.taskId,
          status: settled.state,
          model,
          prompt: typed.prompt,
          text: '',
          ...(settled.url !== undefined ? { videoUrl: settled.url } : {}),
          durationSeconds: duration,
          progress: settled.progress,
          ...(settled.seconds !== undefined ? { effectiveSeconds: settled.seconds } : {}),
          ...(settled.size !== undefined ? { effectiveSize: settled.size } : {}),
          ...(settled.sizeAdjustment !== undefined ? { sizeAdjustment: settled.sizeAdjustment } : {}),
          ...(settled.errorMessage !== undefined ? { errorMessage: settled.errorMessage } : {}),
        }
        value.text = renderVideoText(value)
        if (config.ferryContext && exec.parent !== undefined) {
          exec.deferContext(createUserMessage({
            content: [{ type: 'text', text: value.text }] as ContentBlock[],
            source: {
              kind: 'plugin',
              plugin: name,
              form: 'notice',
              summary: `video ${value.status}: ${typed.prompt.slice(0, 80)}`,
            },
          }))
        }
        return value
      }

      // ── Background mode (default): hand the render to a DSH job. ────────
      let jobId: string
      try {
        jobId = String(startVideoJob(ctx, exec.agent, {
          apiKey,
          videoId: created.videoId,
          taskId: created.taskId,
          model,
          label: `Agnes video: ${typed.prompt.slice(0, 60)}`,
          pollOptions,
          persistVideo: config.persistVideo,
          prompt: typed.prompt,
        }))
      } catch (error) {
        // A composition without a job controller still gets a usable answer:
        // report the task and let the caller poll by task id.
        const fallback: GenerateVideoValue = {
          taskId: created.taskId,
          status: 'queued',
          model,
          prompt: typed.prompt,
          durationSeconds: duration,
          text: [
            '**Video generation started**',
            `- task: ${created.taskId}`,
            `- model: ${model}`,
            `- note: background jobs are unavailable here (${describeFailure(error)}), so the clip is not being tracked automatically.`,
          ].join('\n'),
        }
        return fallback
      }

      const queued: GenerateVideoValue = {
        taskId: created.taskId,
        jobId,
        status: 'queued',
        model,
        prompt: typed.prompt,
        durationSeconds: duration,
        text: renderQueued(created.taskId, jobId, model, typed.prompt),
      }
      return queued
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_video_task',
    description: `Read the state and result of an Agnes video generation started by generate_video or generate_img2vid.
Pass the jobId those tools returned. Reading is idempotent, so it is safe to call repeatedly while the clip renders.
Returns the task state, the video URL once finished, and the local attachment when the file was saved.`,
    parameters: {
      jobId: { type: 'string', required: true, description: 'Background job id returned by generate_video or generate_img2vid.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true, description: 'The job that was read.' },
          status: {
            type: 'string',
            enum: ['queued', 'processing', 'completed', 'failed'],
            required: true,
            description: 'Task state.',
          },
          text: { type: 'string', required: true, description: 'Model-visible summary.' },
          taskId: { type: 'string', description: 'Provider task id.' },
          model: { type: 'string', description: 'The model that was used.' },
          progress: { type: 'integer', description: 'Completion percentage.' },
          videoUrl: { type: 'string', description: 'Download URL, once finished.' },
          attachment: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true, description: 'Durable attachment id.' },
              name: { type: 'string', required: true, description: 'Stored file name.' },
              bytes: { type: 'integer', required: true, description: 'Stored byte length.' },
            },
            description: 'Local copy of the video, when it was saved.',
          },
          effectiveSeconds: { type: 'string', description: 'Duration reported by the provider.' },
          effectiveSize: { type: 'string', description: 'Pixel size reported by the provider.' },
          errorMessage: { type: 'string', description: 'Failure reason, when the task failed.' },
          persistError: { type: 'string', description: 'Why the local copy could not be written.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as GetVideoTaskValue).text }],
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: 'Check video task',
      kind: 'read',
      rawInput: { jobId: args.jobId },
    }),
    async execute(args, exec) {
      const jobId = (args as { jobId: string }).jobId
      const job = readVideoJob(ctx, jobId, exec.agent)
      const lines: string[] = []
      let status: VideoTaskState = 'processing'
      let value: GetVideoTaskValue = { jobId, status, text: '' }

      if (job.result !== undefined) {
        const result: VideoJobResult = job.result
        status = result.state
        value = {
          jobId,
          status,
          text: '',
          taskId: result.taskId,
          model: result.model,
          progress: result.progress,
          ...(result.videoUrl !== undefined ? { videoUrl: result.videoUrl } : {}),
          ...(result.attachment !== undefined ? { attachment: result.attachment } : {}),
          ...(result.persistError !== undefined ? { persistError: result.persistError } : {}),
          ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          ...(result.seconds !== undefined ? { effectiveSeconds: result.seconds } : {}),
          ...(result.size !== undefined ? { effectiveSize: result.size } : {}),
        }
        if (status === 'completed' && result.videoUrl !== undefined) {
          lines.push(
            '**Video ready**',
            `- task: ${result.taskId}`,
            `- model: ${result.model}`,
            result.size !== undefined ? `- size: ${result.size}` : '',
            result.seconds !== undefined ? `- duration: ${result.seconds}s` : '',
            result.sizeAdjustment !== undefined ? `- note: ${result.sizeAdjustment}` : '',
            `- url: ${result.videoUrl}`,
            result.attachment !== undefined
              ? `- saved locally: ${result.attachment.name} (${formatBytes(result.attachment.bytes)})`
              : result.persistError !== undefined ? `- local copy not saved: ${result.persistError}` : '',
          )
        } else {
          lines.push(
            '**Video generation failed**',
            `- task: ${result.taskId}`,
            `- reason: ${result.errorMessage ?? 'unknown error'}`,
          )
        }
      } else if (job.running) {
        status = 'processing'
        value = { jobId, status, text: '' }
        lines.push(
          '**Video still rendering**',
          `- job: ${jobId}`,
          `- state: ${job.status}${job.detail !== undefined ? ` (${job.detail})` : ''}`,
          'Check again later; do not start a duplicate generation.',
        )
      } else {
        status = 'failed'
        value = {
          jobId,
          status,
          text: '',
          ...(job.detail !== undefined ? { errorMessage: job.detail } : {}),
        }
        lines.push(
          '**Video task did not produce a result**',
          `- job: ${jobId}`,
          `- status: ${job.status}`,
          job.detail !== undefined ? `- detail: ${job.detail}` : '',
        )
      }

      value.text = lines.filter(line => line.length > 0).join('\n')
      return value
    },
  }))
}
