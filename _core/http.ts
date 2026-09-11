/**
 * Shared HTTP plumbing for the Agnes AI gateway.
 *
 * Every request goes through {@link agnesJson} so that error classification,
 * cancellation, and time budgets behave identically for images and videos.
 *
 * @module dsh-tool-agnes/core/http
 */

import { AgnesApiError, AgnesMalformedResponseError, AgnesNetworkError, parseErrorBody } from './errors.ts'

/** Agnes AI OpenAI-compatible base URL. */
export const AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1'

/** Agnes AI gateway root, hosting the polling endpoint. */
export const AGNES_ROOT_URL = 'https://apihub.agnes-ai.com'

/** Default time budget for a non-streaming JSON request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 240_000

/** One JSON request against the gateway. */
export interface AgnesRequest {
  /** Bearer API key. */
  apiKey: string
  /** Absolute request URL. */
  url: string
  /** HTTP method. */
  method?: 'GET' | 'POST'
  /** JSON request body, omitted for GET. */
  body?: unknown
  /** Caller cancellation. */
  signal: AbortSignal
  /** Time budget for this single request. */
  timeoutMs?: number
}

/**
 * Combine caller cancellation with a per-request deadline.
 *
 * `AbortSignal.any` keeps the caller's signal authoritative: cancelling the
 * tool cancels the request even while the deadline is still in the future.
 *
 * @param signal - caller cancellation.
 * @param timeoutMs - request budget.
 * @returns a signal that aborts on either condition.
 */
function withDeadline(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

/**
 * Perform one JSON request and parse its envelope.
 *
 * @param request - method, URL, body, credentials, and cancellation.
 * @returns the parsed JSON body.
 * @throws AgnesApiError on a non-2xx response.
 * @throws AgnesNetworkError when the request never produced a response.
 * @throws AgnesMalformedResponseError when the body is not JSON.
 */
export async function agnesJson<T>(request: AgnesRequest): Promise<T> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: withDeadline(request.signal, timeoutMs),
    })
  } catch (error) {
    throw new AgnesNetworkError(error, request.signal.aborted)
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new AgnesApiError(response.status, parseErrorBody(text), text)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AgnesMalformedResponseError(`Agnes ${request.method ?? 'POST'} ${new URL(request.url).pathname}`, text)
  }
}

/**
 * Download raw bytes from a provider-supplied URL.
 * @param url - absolute HTTP(S) URL.
 * @param signal - caller cancellation.
 * @param timeoutMs - download budget.
 * @returns the response bytes.
 * @throws Error when the download fails.
 */
export async function downloadBytes(
  url: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url, { signal: withDeadline(signal, timeoutMs) })
  } catch (error) {
    throw new AgnesNetworkError(error, signal.aborted)
  }
  if (!response.ok) {
    throw new Error(`failed to download the generated media: HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Wait for one polling interval, honouring cancellation.
 * @param ms - delay in milliseconds.
 * @param signal - caller cancellation.
 */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AgnesNetworkError(new Error('aborted'), true))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AgnesNetworkError(new Error('aborted'), true))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
