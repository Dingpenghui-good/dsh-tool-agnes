/**
 * Cancellable delay primitive.
 *
 * Lives in its own module so the retry policy (`rate-limit.ts`) and the HTTP
 * layer (`http.ts`) can both use it without importing each other.
 *
 * @module dsh-tool-agnes/core/sleep
 */

import { AgnesNetworkError } from './errors.ts'

/**
 * Wait for one interval, honouring cancellation.
 *
 * Rejects with a `cancelled` {@link AgnesNetworkError} when `signal` aborts
 * while waiting, so a cancelled tool call stops waiting immediately instead
 * of finishing its backoff first.
 *
 * @param ms - delay in milliseconds.
 * @param signal - caller cancellation.
 * @returns a promise that settles after the delay.
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
