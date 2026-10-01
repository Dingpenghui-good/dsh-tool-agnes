/**
 * Background video generation as a DSH job.
 *
 * A video takes minutes to render (272s measured for an 8s 1080p clip), so a
 * tool call must not sit on the poll loop. Instead the tool creates the
 * provider task and registers a job that polls in the background; the call
 * returns immediately with the task identity, and {@link readVideoJob} returns
 * the structured result afterwards.
 *
 * Written against the `@deepseek-ai/dsh-jobs` 0.1.7 Service Definition
 * (DSH 0.2.0 line): the producer face is synchronous (`run(job)` returns
 * `{ cancel, done }`), the owner is a bare `SessionId`, the terminal value
 * travels through {@link JobOutcome.result}, and readers consume
 * `ctx.jobs.read`, whose result is handed out once after settlement.
 *
 * @module dsh-tool-agnes/core/video-job
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobKind, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { describeFailure } from './errors.ts'
import { awaitVideoTask, fetchVideoBytes } from './video.ts'
import type { PollOptions, VideoPollResult, VideoTaskState } from './video.ts'

/**
 * Producer kind for every Agnes video job.
 *
 * `@deepseek-ai/dsh-jobs` declares `JobKindMap` as merge-extensible, so a
 * plugin widens it with a declaration merge; at runtime the registry treats a
 * kind as an opaque id namespace, so a widened literal is both safe and the
 * only option. It also becomes the job id prefix (`agnes-video-1`).
 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'agnes-video': 'agnes-video'
  }
}

/** The widened literal, used at the call site where the merged type is visible. */
const AGNES_VIDEO_KIND = 'agnes-video' as JobKind

/** One durable attachment reference, projected for JSON output. */
export interface PersistedVideo {
  attachmentId: string
  name: string
  bytes: number
}

/** Description of one background video generation. */
export interface VideoJobSpec {
  /** Bearer API key. */
  apiKey: string
  /** Provider query handle. */
  videoId: string
  /** Provider task id, echoed in the result. */
  taskId: string
  /** Model id, needed by the 2.5 family when polling. */
  model: string
  /** One-line model-facing job label. */
  label: string
  /** Polling policy for the background loop. */
  pollOptions: PollOptions
  /** Whether to download the finished video into the attachment store. */
  persistVideo: boolean
  /** Source image URL, for image-to-video results. */
  imageUrl?: string
  /** The prompt that was submitted. */
  prompt?: string
}

/** Structured result of a finished video job. */
export interface VideoJobResult {
  taskId: string
  videoId: string
  state: VideoTaskState
  model: string
  progress: number
  prompt?: string
  imageUrl?: string
  videoUrl?: string
  attachment?: PersistedVideo
  persistError?: string
  errorMessage?: string
  seconds?: string
  size?: string
  sizeAdjustment?: string
}

/** Registry status of one job, as seen by a reader. */
export interface VideoJobStatus {
  /** DSH job id. */
  jobId: string
  /** DSH job status: running / stopping / completed / killed / failed. */
  status: string
  /** Model-facing detail line, when the producer supplied one. */
  detail?: string
  /** The parsed result, present once the job settled. */
  result?: VideoJobResult
  /** True when the job has not settled yet. */
  running: boolean
}

/**
 * The owner's session id, when a caller agent is present.
 *
 * `JobSpec.owner` is a bare `SessionId` (an Agent's `id` IS its session id);
 * omitting it creates an unowned job, which every caller may read.
 *
 * @param owner - the calling agent, when one is present.
 * @returns the branded session id, or undefined for an unowned job.
 */
function ownerOf(owner: Agent | undefined): Agent['id'] | undefined {
  return owner?.id
}

/**
 * Register a background job that polls one provider task to completion.
 *
 * @param ctx - plugin context; must carry the `jobs` service.
 * @param owner - the calling agent, so the job is fenced to its session.
 * @param spec - task identity, polling policy, and persistence choice.
 * @returns the DSH job id.
 * @throws Error when the jobs service is unavailable or no controller is attached.
 */
export function startVideoJob(ctx: Context, owner: Agent | undefined, spec: VideoJobSpec): JobId {
  const controller = new AbortController()

  return ctx.jobs.start({
    kind: AGNES_VIDEO_KIND,
    label: spec.label,
    ...(ownerOf(owner) !== undefined ? { owner: ownerOf(owner) } : {}),
    run(job) {
      const done = (async (): Promise<JobOutcome> => {
        try {
          const settled = await awaitVideoTask(
            spec.apiKey,
            spec.videoId,
            spec.model,
            spec.pollOptions,
            controller.signal,
          )
          const result = await finalize(ctx, spec, settled, controller.signal)
          // Narrate progress through the ring; the terminal value rides `result`.
          job.append(`video ${spec.taskId}: ${settled.state}`)
          return {
            status: settled.state === 'failed' ? 'failed' : 'completed',
            detail: settled.state,
            result: JSON.stringify(result),
          }
        } catch (error) {
          const failure: VideoJobResult = {
            taskId: spec.taskId,
            videoId: spec.videoId,
            state: 'failed',
            model: spec.model,
            progress: 0,
            errorMessage: describeFailure(error),
            ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
            ...(spec.imageUrl !== undefined ? { imageUrl: spec.imageUrl } : {}),
          }
          return {
            status: controller.signal.aborted ? 'killed' : 'failed',
            detail: controller.signal.aborted ? 'cancelled' : 'failed',
            result: JSON.stringify(failure),
          }
        }
      })()

      return {
        cancel: (): void => { controller.abort() },
        done,
      }
    },
  })
}

/**
 * Materialize the terminal result, downloading the video when requested.
 *
 * Persistence is best-effort: the provider URL is still reported when the
 * download or the attachment write fails, so a storage problem never hides a
 * finished video.
 *
 * @param ctx - plugin context.
 * @param spec - the job description.
 * @param settled - the terminal polling observation.
 * @param signal - cancellation for the download.
 * @returns the structured result.
 */
async function finalize(
  ctx: Context,
  spec: VideoJobSpec,
  settled: VideoPollResult,
  signal: AbortSignal,
): Promise<VideoJobResult> {
  const result: VideoJobResult = {
    taskId: spec.taskId,
    videoId: spec.videoId,
    state: settled.state,
    model: spec.model,
    progress: settled.progress,
    ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
    ...(spec.imageUrl !== undefined ? { imageUrl: spec.imageUrl } : {}),
    ...(settled.url !== undefined ? { videoUrl: settled.url } : {}),
    ...(settled.errorMessage !== undefined ? { errorMessage: settled.errorMessage } : {}),
    ...(settled.seconds !== undefined ? { seconds: settled.seconds } : {}),
    ...(settled.size !== undefined ? { size: settled.size } : {}),
    ...(settled.sizeAdjustment !== undefined ? { sizeAdjustment: settled.sizeAdjustment } : {}),
  }

  if (settled.state !== 'completed' || settled.url === undefined || !spec.persistVideo) return result

  try {
    const bytes = await fetchVideoBytes(settled.url, signal)
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      result.persistError = 'the attachment service is unavailable, so the video was not saved'
      return result
    }
    const ref = await attachments.saveFile({ data: bytes, name: `agnes-video-${spec.taskId}.mp4` })
    result.attachment = {
      attachmentId: String(ref.attachmentId),
      name: ref.name,
      bytes: ref.bytes,
    }
  } catch (error) {
    result.persistError = describeFailure(error)
  }
  return result
}

/**
 * Read the current state of one Agnes video job.
 *
 * Reading consumes the model cursor: an unsettled job yields no result, and a
 * settled one hands out its producer result exactly once. Reading a settled
 * job repeatedly therefore reports the same lifecycle state but the parsed
 * result only on the first read; callers that need the value afterwards keep
 * it in the tool's own output.
 *
 * @param ctx - plugin context; must carry the `jobs` service.
 * @param jobId - the DSH job id returned when the task was created.
 * @param caller - reading agent, checked against the job owner.
 * @returns the job status and, once settled, its parsed result.
 * @throws Error when the job is unknown or owned by another session.
 */
export function readVideoJob(ctx: Context, jobId: string, caller: Agent | undefined): VideoJobStatus {
  const reader = ownerOf(caller)
  const read = ctx.jobs.read(jobId as JobId, reader)
  const view = read.job
  const status: VideoJobStatus = {
    jobId: String(view.id),
    status: view.status,
    running: view.status === 'running' || view.status === 'stopping',
    ...(view.detail !== undefined ? { detail: view.detail } : {}),
  }
  if (status.running || read.result === undefined) return status
  try {
    status.result = JSON.parse(read.result) as VideoJobResult
  } catch {
    // A settled job whose result is not our JSON: report the raw text instead.
    status.detail = read.result.slice(0, 400)
  }
  return status
}
