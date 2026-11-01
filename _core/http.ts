/**
 * Shared HTTP plumbing for the Agnes AI gateway.
 *
 * Every request goes through {@link agnesJson} so that error classification,
 * cancellation, and time budgets behave identically for images and videos.
 *
 * @module dsh-tool-agnes/core/http
 */

import { AgnesApiError, AgnesMalformedResponseError, AgnesNetworkError, parseErrorBody } from './errors.ts'
import {
  DEFAULT_RATE_LIMIT_POLICY,
  backoffDelay,
  forgetHistory,
  limiterFor,
  parseRetryAfterMs,
  type RateLimitPolicy,
} from './rate-limit.ts'
import { sleep } from './sleep.ts'

// Re-exported so existing callers keep importing `sleep` from this module.
export { sleep }

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
  /** Pacing and retry overrides; omitted fields use the free-tier defaults. */
  rateLimit?: Partial<RateLimitPolicy>
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
 * The request is paced against the free-tier quota before it is sent, and a
 * 429 answer is retried after a backoff instead of being surfaced
 * immediately. Both behaviours are controlled by `request.rateLimit`.
 *
 * @param request - method, URL, body, credentials, cancellation, and pacing policy.
 * @returns the parsed JSON body.
 * @throws AgnesApiError on a non-2xx response whose retries are exhausted.
 * @throws AgnesNetworkError when the request never produced a response.
 * @throws AgnesMalformedResponseError when the body is not JSON.
 */
export async function agnesJson<T>(request: AgnesRequest): Promise<T> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const policy: RateLimitPolicy = { ...DEFAULT_RATE_LIMIT_POLICY, ...request.rateLimit }
  const limiter = policy.requestsPerWindow > 0
    ? limiterFor(request.apiKey, policy.requestsPerWindow, policy.windowMs)
    : undefined

  for (let attempt = 0; ; attempt++) {
    // Proactive pacing: wait for a free slot before touching the network, so
    // a single-process workload rarely reaches the gateway's own limit.
    if (limiter !== undefined) await limiter.acquire(request.signal)

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

    if (response.status === 429) {
      const error = new AgnesApiError(response.status, parseErrorBody(text), text)
      // The attempt counted against the window even though the gateway
      // refused it, so a retry is only worth making while attempts remain.
      if (attempt >= policy.maxRetries || request.signal.aborted) throw error
      const wait = backoffDelay(
        attempt + 1,
        parseRetryAfterMs(response),
        policy.baseDelayMs,
        policy.maxDelayMs,
        policy.gatewayWindowMs,
      )
      await sleep(wait, request.signal)
      continue
    }

    if (!response.ok) {
      throw new AgnesApiError(response.status, parseErrorBody(text), text)
    }

    // A retried call succeeded, so the local window no longer describes the
    // gateway's; drop it to let the next burst pace from a clean slate.
    if (attempt > 0) forgetHistory(request.apiKey)

    try {
      return JSON.parse(text) as T
    } catch {
      throw new AgnesMalformedResponseError(`Agnes ${request.method ?? 'POST'} ${new URL(request.url).pathname}`, text)
    }
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
