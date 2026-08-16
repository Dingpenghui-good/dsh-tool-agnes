/**
 * Type definitions for the Agnes AI API responses and plugin interfaces.
 */

/** One image item in the generation response. */
export interface AgnesImageItem {
  /** Generated image URL. */
  url?: string
  /** Base64-encoded image data. */
  b64_json?: string
  /** Revised prompt returned by the model. */
  revised_prompt?: string
  /** Width in pixels. */
  width?: number
  /** Height in pixels. */
  height?: number
  /** Declared size tier (e.g. "1K", "2K"). */
  size?: string
  /** Aspect ratio (e.g. "1:1", "16:9"). */
  ratio?: string
  /** Seed used for generation, if any. */
  seed?: number
}

/** Token usage reported by the API. */
export interface AgnesUsage {
  prompt_tokens?: number
  total_tokens?: number
  completion_tokens?: number
}

/** Full response body from POST /v1/images/generations. */
export interface AgnesImageResponse {
  id?: string
  data: AgnesImageItem[]
  usage?: AgnesUsage
  error?: { message: string; code?: number }
}

/** Video generation task status. */
export type VideoTaskStatus = 'queued' | 'processing' | 'completed' | 'failed'

/** Arguments for the generate_video tool. */
export interface GenerateVideoArgs {
  /** Text prompt describing the video to generate */
  prompt: string
  /** Optional duration of the video in seconds (default: 8) */
  duration?: number
  /** Optional width of the video (default: 1920) */
  width?: number
  /** Optional height of the video (default: 1080) */
  height?: number
  /** Optional frame rate (default: 24) */
  frameRate?: number
  /** Optional seed for reproducible results */
  seed?: number
  /** Optional negative prompt */
  negativePrompt?: string
  /** Optional image URL for image-to-video */
  imageUrl?: string
}

/** Output schema for generate_video. */
export interface GenerateVideoOutput {
  taskId: string
  status: VideoTaskStatus
  videoUrl?: string
  prompt: string
  width?: number
  height?: number
  duration?: number
  frameRate?: number
  progress?: number
  errorMessage?: string
}

/** Full response body from POST /v1/videos. */
export interface AgnesVideoCreateResponse {
  video_id?: string
  task_id?: string
  id?: string
  status?: string
  progress?: number
}

/** Poll response body from GET /agnesapi?video_id=... */
export interface AgnesVideoPollResponse {
  video_id?: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress?: number
  error?: { message?: string; code?: number } | string
  metadata?: { url?: string }
}
