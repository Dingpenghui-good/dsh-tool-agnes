/**
 * Wire-level response types for the Agnes AI gateway.
 *
 * @module dsh-tool-agnes/core/types
 */

/** Provider error envelope shared by every Agnes endpoint. */
export interface AgnesErrorBody {
  message?: string
  code?: string | number
  type?: string
  param?: string
}

/** One image item in the `POST /v1/images/generations` response. */
export interface AgnesImageItem {
  /** Generated image URL. */
  url?: string
  /** Base64 bytes; empty unless the endpoint produced them. */
  b64_json?: string
  /** Prompt the model actually used, when reported. */
  revised_prompt?: string
}

/** Response body of `POST /v1/images/generations`. */
export interface AgnesImageResponse {
  /** Provider-side task identifier. */
  task_id?: string
  /** Unix seconds. */
  created?: number
  /** Generated images, in request order. */
  data?: AgnesImageItem[]
  error?: AgnesErrorBody
  success?: boolean
}

/** Response of `POST /v1/videos`. */
export interface AgnesVideoCreateResponse {
  /** Query handle used by `GET /agnesapi`. */
  video_id?: string
  /** Task id, identical to `id` when present. */
  task_id?: string
  /** Task id. */
  id?: string
  object?: string
  model?: string
  status?: string
  progress?: number
  seconds?: string
  size?: string
  created_at?: number
  error?: AgnesErrorBody
}

/**
 * Response of `GET /agnesapi?video_id=…`.
 *
 * The gateway reports progress through several overlapping fields and is not
 * consistent about which are present at which stage: early polls may omit
 * `status` entirely, and the finished video URL is a TOP-LEVEL `url` rather
 * than `metadata.url`.
 */
export interface AgnesVideoPollResponse {
  id?: string
  object?: string
  /** Present only after the queue leaves its initial state. */
  status?: string
  /** Always-present mirror of `status`. */
  internal_status?: string
  progress?: number
  internal_progress?: number
  /** Unix seconds; non-null exactly when generation finished. */
  completed_at?: number | null
  /** Non-null exactly when generation failed. */
  error?: AgnesErrorBody | string | null
  /** Download URL of the finished video. */
  url?: string | null
  /** Legacy location some responses used for the same URL. */
  metadata?: { url?: string } | null
  seconds?: string
  size?: string
  perf_output_size?: number
  size_mapping?: {
    adjusted?: boolean
    width?: number
    height?: number
    ratio?: string
    resolution?: string
    message?: string
  } | null
}
