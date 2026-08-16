/**
 * Type definitions for the Agnes AI image-to-video plugin.
 */

/** Video generation task status. */
export type VideoTaskStatus = 'queued' | 'processing' | 'completed' | 'failed'

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
