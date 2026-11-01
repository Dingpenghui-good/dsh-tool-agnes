/**
 * Adaptive pacing and retry for the Agnes free-tier rate limit.
 *
 * The Agnes gateway enforces a per-key quota measured at 6 requests per
 * 60-second sliding window (verified 2026-11-01): the seventh request inside
 * one window answers HTTP 429 with
 * `You've reached the API rate limit for free users`.
 *
 * Two mechanisms keep calls inside that budget:
 *
 * - **Proactive pacing** — {@link RateLimiter} remembers the times of recent
 *   attempts for one key and delays the next call until a slot frees. Most
 *   limit hits therefore never happen in the first place.
 * - **Reactive backoff** — when the gateway answers 429 anyway (a concurrent
 *   process sharing the key, or a quota the limiter does not know about), the
 *   caller waits for the window and tries again, honouring `Retry-After` when
 *   the gateway supplies one.
 *
 * The limiter is deliberately process-local: it cannot see other processes
 * using the same key, which is exactly why the reactive half is still needed.
 *
 * @module dsh-tool-agnes/core/rate-limit
 */

import { sleep } from './sleep.ts'

/** Default window length the free tier is measured over. */
export const DEFAULT_RATE_WINDOW_MS = 60_000

/** Default attempts allowed inside one window. */
export const DEFAULT_RATE_LIMIT = 6

/**
 * Default number of 429 retries before the failure is surfaced.
 *
 * Each retry waits out the gateway window, so a handful of retries already
 * covers several minutes of an exhausted free-tier quota.
 */
export const DEFAULT_MAX_RATE_RETRIES = 4

/** Default first backoff delay, doubled per attempt. */
export const DEFAULT_BASE_DELAY_MS = 3_000

/** Default cap on a single backoff delay. */
export const DEFAULT_MAX_DELAY_MS = 60_000

/** Limits the number of attempts allowed inside a sliding window. */
export class RateLimiter {
  /** Window length in milliseconds. */
  private readonly windowMs: number
  /** Attempts permitted per window; 0 disables pacing entirely. */
  private readonly limit: number
  /** Monotonic-ish timestamps of recent attempts, oldest first. */
  private readonly stamps: number[] = []

  /**
   * @param limit - attempts permitted per window; `0` disables pacing.
   * @param windowMs - window length in milliseconds.
   */
  constructor(limit: number, windowMs: number = DEFAULT_RATE_WINDOW_MS) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Whether pacing is active. */
  get enabled(): boolean {
    return this.limit > 0
  }

  /** Attempts currently counted inside the window. */
  get used(): number {
    const cutoff = Date.now() - this.windowMs
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift()
    return this.stamps.length
  }

  /**
   * Reserve one slot, waiting until the window has room.
   *
   * Concurrent callers are serialized through this method: each reservation
   * is recorded before the next one evaluates the window, so two parallel
   * calls cannot both observe the same free slot.
   *
   * @param signal - caller cancellation; waiting stops when it aborts.
   * @returns the milliseconds waited (0 when a slot was free).
   */
  async acquire(signal: AbortSignal): Promise<number> {
    if (!this.enabled) return 0
    const started = Date.now()
    for (;;) {
      const cutoff = Date.now() - this.windowMs
      while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift()

      if (this.stamps.length < this.limit) {
        this.stamps.push(Date.now())
        return Date.now() - started
      }

      // Wait for the oldest attempt to leave the window. A small margin keeps
      // clock skew and the gateway's own window boundary from racing us.
      const waitMs = this.windowMs - (Date.now() - this.stamps[0]) + 50
      await sleep(Math.max(50, waitMs), signal)
    }
  }
}

/** Process-wide limiters, one per API key. */
const limiters = new Map<string, RateLimiter>()

/**
 * Fetch the limiter for one key, creating it on first use.
 *
 * Keying by API key (not by plugin instance) matches how the gateway counts:
 * two tools sharing one key also share one budget.
 *
 * @param apiKey - bearer key identifying the quota.
 * @param limit - attempts per window when creating; ignored once created.
 * @param windowMs - window length when creating.
 * @returns the shared limiter.
 */
export function limiterFor(
  apiKey: string,
  limit: number,
  windowMs: number = DEFAULT_RATE_WINDOW_MS,
): RateLimiter {
  const existing = limiters.get(apiKey)
  if (existing !== undefined) return existing
  const created = new RateLimiter(limit, windowMs)
  limiters.set(apiKey, created)
  return created
}

/** Resets every cached limiter. Intended for tests. */
export function resetLimiters(): void {
  limiters.clear()
}

/** Read the gateway's `Retry-After` hint, when it sent a usable one. */
export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, DEFAULT_MAX_DELAY_MS)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) {
    const delta = date - Date.now()
    return delta > 0 ? Math.min(delta, DEFAULT_MAX_DELAY_MS) : 0
  }
  return undefined
}

/**
 * Compute the delay before the next attempt.
 *
 * Exponential by attempt, with a jitter band of `[delay/2, delay]` so several
 * callers that hit the limit together do not retry in lockstep and re-trigger
 * it. A gateway-supplied `retryAfterMs` always wins, because it is the only
 * signal that knows the real window boundary.
 *
 * The result is then floored at `gatewayWindowMs`: once the gateway has said
 * 429, every request inside its current window will be refused too, so a
 * shorter wait only spends attempts without buying a chance of success.
 *
 * @param attempt - 1-based retry number.
 * @param retryAfterMs - gateway hint, when present.
 * @param baseDelayMs - first-attempt delay.
 * @param maxDelayMs - cap on one delay.
 * @param gatewayWindowMs - the gateway quota window the wait must clear.
 * @returns the milliseconds to wait.
 */
export function backoffDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
  gatewayWindowMs: number = DEFAULT_RATE_WINDOW_MS,
): number {
  if (retryAfterMs !== undefined) {
    return Math.max(gatewayWindowMs, Math.min(retryAfterMs, maxDelayMs))
  }
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1))
  const jitter = ceiling / 2 + Math.random() * (ceiling / 2)
  return Math.round(Math.min(maxDelayMs, Math.max(gatewayWindowMs, jitter)))
}

/**
 * Forget every attempt recorded for one key.
 *
 * Called after a retry succeeds, so the window the limiter remembers matches
 * the gateway's again instead of staying artificially full.
 *
 * @param apiKey - the key whose history should be dropped.
 */
export function forgetHistory(apiKey: string): void {
  limiters.delete(apiKey)
}

/** Configuration shared by every retrying call. */
export interface RateLimitPolicy {
  /** Attempts permitted per window; `0` disables proactive pacing. */
  requestsPerWindow: number
  /** Window length in milliseconds. */
  windowMs: number
  /** 429 retries tolerated before surfacing the failure. */
  maxRetries: number
  /** First backoff delay in milliseconds. */
  baseDelayMs: number
  /** Cap on a single backoff delay in milliseconds. */
  maxDelayMs: number
  /**
   * The gateway's own quota window, which a 429 backoff must clear.
   *
   * Never derived from `windowMs`: pacing is a local approximation the caller
   * may configure to any length, while the gateway keeps counting over its
   * real window. When the two differ, an exponential backoff that stays under
   * the gateway window retries into the same exhausted quota and burns every
   * remaining attempt — measured in a live test where a 10 s local window
   * against the real 60 s gateway window lost 5 of 12 calls.
   */
  gatewayWindowMs: number
}

/** The policy used when a caller configures nothing. */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  requestsPerWindow: DEFAULT_RATE_LIMIT,
  windowMs: DEFAULT_RATE_WINDOW_MS,
  maxRetries: DEFAULT_MAX_RATE_RETRIES,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  gatewayWindowMs: DEFAULT_RATE_WINDOW_MS,
}

/** The plugin-config fields that configure the policy. */
export interface RateLimitConfig {
  /** Attempts per window; `0` disables proactive pacing. */
  rateLimitRequestsPerWindow: number
  /** Window length in milliseconds. */
  rateLimitWindowMs: number
  /** 429 retries tolerated. */
  rateLimitMaxRetries: number
  /** First backoff delay in milliseconds. */
  rateLimitBaseDelayMs: number
}

/**
 * Project plugin configuration onto the policy the HTTP layer consumes.
 *
 * @param config - the plugin's rate-limit configuration section.
 * @returns a complete policy.
 */
export function policyFromConfig(config: RateLimitConfig): RateLimitPolicy {
  return {
    requestsPerWindow: config.rateLimitRequestsPerWindow,
    windowMs: config.rateLimitWindowMs,
    maxRetries: config.rateLimitMaxRetries,
    baseDelayMs: config.rateLimitBaseDelayMs,
    // A 429 backoff has to outlast the gateway's window, not the local one,
    // so the cap is never allowed to sit below it.
    maxDelayMs: Math.max(DEFAULT_MAX_DELAY_MS, DEFAULT_RATE_WINDOW_MS),
    gatewayWindowMs: DEFAULT_RATE_WINDOW_MS,
  }
}
