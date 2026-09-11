/**
 * Agnes AI text-to-image client.
 *
 * The endpoint accepts only `model`, `prompt`, `size`, and `ratio`. Verified
 * against the live gateway: the text image queue rejects `stream`, `format`,
 * `images` (image-to-image), and any `n` other than 1 with HTTP 400
 * `... is not supported by text image queue` / `n must be 1`.
 *
 * @module dsh-tool-agnes/core/image
 */

import { AGNES_BASE_URL, agnesJson, downloadBytes } from './http.ts'
import type { AgnesImageResponse } from './types.ts'

/** Image model identifiers currently served by the Agnes gateway. */
export const IMAGE_MODELS = [
  'agnes-image-2.5-flash',
  'agnes-image-2.1-flash',
  'agnes-image-2.0-flash',
] as const

/** One selectable image model id. */
export type ImageModel = (typeof IMAGE_MODELS)[number]

/** Normalized image payload the plugins work with internally. */
export interface GeneratedImage {
  /** Remote HTTP(S) URL, when the provider returned one. */
  url?: string
  /** Base64 payload, when the provider returned one. */
  b64Json?: string
}

/** Arguments for one text-to-image request. */
export interface GenerateImageRequest {
  /** Bearer API key. */
  apiKey: string
  /** Image model id. */
  model: string
  /** Natural-language prompt. */
  prompt: string
  /** Resolution tier. */
  size: string
  /** Aspect ratio. */
  ratio: string
  /** Caller cancellation. */
  signal: AbortSignal
  /** Per-request time budget. */
  timeoutMs?: number
}

/**
 * Generate one image.
 * @param request - prompt, model, shape, and cancellation.
 * @returns the generated image and the provider task id.
 * @throws AgnesApiError on a non-2xx response.
 */
export async function generateImage(request: GenerateImageRequest): Promise<{
  image: GeneratedImage
  taskId: string | undefined
}> {
  const body = await agnesJson<AgnesImageResponse>({
    apiKey: request.apiKey,
    url: `${AGNES_BASE_URL}/images/generations`,
    body: {
      model: request.model,
      prompt: request.prompt,
      size: request.size,
      ratio: request.ratio,
    },
    signal: request.signal,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  })

  const item = body.data?.[0]
  if (item === undefined) {
    throw new Error(
      `Agnes returned no image data${body.error?.message !== undefined ? `: ${body.error.message}` : ''}`,
    )
  }

  const url = item.url !== undefined && item.url.length > 0 ? item.url : undefined
  const b64Json = item.b64_json !== undefined && item.b64_json.length > 0 ? item.b64_json : undefined
  if (url === undefined && b64Json === undefined) {
    throw new Error('Agnes returned neither a URL nor base64 data for the generated image')
  }

  return { image: { url, b64Json }, taskId: body.task_id }
}

/**
 * Obtain the bytes of one generated image.
 *
 * A base64 payload is decoded locally; otherwise the returned URL is
 * downloaded under the caller's cancellation.
 *
 * @param image - the normalized image payload.
 * @param signal - caller cancellation.
 * @returns the encoded image bytes.
 */
export async function fetchImageBytes(image: GeneratedImage, signal: AbortSignal): Promise<Uint8Array> {
  if (image.b64Json !== undefined) {
    return new Uint8Array(Buffer.from(image.b64Json, 'base64'))
  }
  if (image.url === undefined) {
    throw new Error('generated image carries no URL and no base64 payload')
  }
  return downloadBytes(image.url, signal)
}
