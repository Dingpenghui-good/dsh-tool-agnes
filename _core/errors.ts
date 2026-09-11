/**
 * Error classification for the Agnes AI gateway.
 *
 * A raw `Agnes API error 400: ...` tells the model nothing it can act on. Every
 * failure is therefore classified into a {@link AgnesFailureKind} and paired
 * with a concrete {@link AgnesApiError.advice} line, so a failed tool call
 * carries the next step instead of just the diagnosis.
 *
 * @module dsh-tool-agnes/core/errors
 */

import type { AgnesErrorBody } from './types.ts'

/** How a failed Agnes call should be understood. */
export type AgnesFailureKind =
  | 'auth'
  | 'forbidden'
  | 'rate-limit'
  | 'invalid-request'
  | 'unsupported-field'
  | 'upstream'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'malformed'

/**
 * Parse an error envelope without trusting the body to be JSON.
 * @param text - raw response body.
 * @returns the provider error object, or undefined when the body is not an envelope.
 */
export function parseErrorBody(text: string): AgnesErrorBody | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: AgnesErrorBody }
    const error = parsed?.error
    return typeof error === 'object' && error !== null ? error : undefined
  } catch {
    return undefined
  }
}

/**
 * Classify one HTTP failure from its status and provider envelope.
 * @param status - HTTP status.
 * @param body - parsed provider error envelope, when present.
 * @returns the failure kind.
 */
function classify(status: number, body: AgnesErrorBody | undefined): AgnesFailureKind {
  const message = body?.message ?? ''
  const type = body?.type ?? ''
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate-limit'
  if (status === 404) return 'invalid-request'
  if (status >= 500) return 'server'
  if (/is not supported by/i.test(message)) return 'unsupported-field'
  if (type === 'upstream_error') return 'upstream'
  if (status === 400 || status === 422) return 'invalid-request'
  return 'invalid-request'
}

/** The next step a caller should take for one failure kind. */
function adviceFor(kind: AgnesFailureKind, body: AgnesErrorBody | undefined): string {
  switch (kind) {
    case 'auth':
      return 'The Agnes API key is missing or rejected. Store AGNES_AI_API_KEY in $DSH_HOME/.credentials.yaml (under `refs`) or export the same name, then retry.'
    case 'forbidden':
      return 'The key is valid but not permitted for this model or endpoint. Check the account plan, or pick a different model.'
    case 'rate-limit':
      return 'The Agnes rate limit was reached (free tier). Do not retry immediately — wait for the quota window to reset, or upgrade to a Token Plan.'
    case 'unsupported-field':
      return `The endpoint rejected a field it no longer accepts: "${body?.message ?? ''}". Remove that field from the request rather than retrying as-is.`
    case 'upstream':
      return 'The Agnes gateway failed to route this request to a model. This usually means the request shape is wrong for the selected model.'
    case 'server':
      return 'Agnes reported a server-side error. This is usually transient — retry once after a short pause.'
    case 'network':
      return 'The request could not reach the Agnes gateway. Check connectivity, then retry.'
    case 'timeout':
      return 'The request exceeded its time budget. For video, raise timeoutMs in the plugin config; for images, retry.'
    case 'cancelled':
      return 'The call was cancelled by the caller.'
    case 'malformed':
      return 'Agnes returned a body that is not the documented JSON envelope. Treat the result as unknown.'
    case 'invalid-request':
      return 'Agnes rejected the request parameters. Re-read the model documentation for the exact accepted fields.'
  }
}

/** A failed Agnes HTTP call, classified and paired with actionable advice. */
export class AgnesApiError extends Error {
  /** HTTP status of the failed response. */
  readonly status: number
  /** Provider error code, when the envelope carried one. */
  readonly code: string | number | undefined
  /** Provider error type, when the envelope carried one. */
  readonly type: string | undefined
  /** Provider error message, when the envelope carried one. */
  readonly providerMessage: string | undefined
  /** Classified failure kind. */
  readonly kind: AgnesFailureKind
  /** What the caller should do next. */
  readonly advice: string

  constructor(status: number, body: AgnesErrorBody | undefined, rawText: string) {
    const providerMessage = body?.message?.trim()
    const detail = providerMessage !== undefined && providerMessage.length > 0
      ? providerMessage
      : rawText.slice(0, 300) || 'no response body'
    const kind = classify(status, body)
    super(`Agnes API error ${status}: ${detail}`)
    this.name = 'AgnesApiError'
    this.status = status
    this.code = body?.code
    this.type = body?.type
    this.providerMessage = providerMessage
    this.kind = kind
    this.advice = adviceFor(kind, body)
  }

  /**
   * Whether this failure is the free-tier rate limit, which must not be retried.
   * @returns true for HTTP 429 and for the provider's rate-limit code.
   */
  get isRateLimit(): boolean {
    return this.kind === 'rate-limit' || this.code === 'rate_limit_exceeded'
  }

  /**
   * Whether an immediate retry is worth attempting.
   * @returns true only for transient server-side failures.
   */
  get retryable(): boolean {
    return this.kind === 'server'
  }
}

/** A transport-level failure: the request never produced an HTTP response. */
export class AgnesNetworkError extends Error {
  /** Classified failure kind. */
  readonly kind: AgnesFailureKind
  /** What the caller should do next. */
  readonly advice: string

  constructor(cause: unknown, cancelled: boolean) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const kind: AgnesFailureKind = cancelled ? 'cancelled' : 'network'
    super(cancelled ? 'the Agnes call was cancelled' : `the Agnes request failed to reach the gateway: ${reason}`)
    this.name = 'AgnesNetworkError'
    this.kind = kind
    this.advice = adviceFor(kind, undefined)
  }
}

/** Agnes answered with a body outside the documented envelope. */
export class AgnesMalformedResponseError extends Error {
  /** Classified failure kind. */
  readonly kind: AgnesFailureKind = 'malformed'
  /** What the caller should do next. */
  readonly advice: string

  constructor(context: string, rawText: string) {
    super(`${context} returned a non-JSON body: ${rawText.slice(0, 300)}`)
    this.name = 'AgnesMalformedResponseError'
    this.advice = adviceFor('malformed', undefined)
  }
}

/**
 * Render any thrown value as one actionable line for the model.
 * @param error - the thrown value.
 * @returns `<message> — <advice>`, or the plain message when unclassified.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof AgnesApiError || error instanceof AgnesNetworkError || error instanceof AgnesMalformedResponseError) {
    return `${error.message}\nNext step: ${error.advice}`
  }
  return error instanceof Error ? error.message : String(error)
}
