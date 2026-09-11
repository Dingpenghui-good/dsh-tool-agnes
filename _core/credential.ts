/**
 * Credential resolution shared by every Agnes plugin.
 *
 * `AGNES_AI_API_KEY` is the name the Agnes documentation and this deployment
 * use; `AGNES_API_KEY` is accepted as a legacy fallback so an existing setup
 * keeps working.
 *
 * @module dsh-tool-agnes/core/credential
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Candidate credential references, in priority order. */
const KEY_REFS = [
  credentialRef('AGNES_AI_API_KEY'),
  credentialRef('AGNES_API_KEY'),
] as const

/**
 * Resolve the Agnes AI API key.
 * @param ctx - plugin context carrying the optional `credentials` service.
 * @returns the first configured key.
 * @throws Error when no candidate reference resolves.
 */
export async function readCredential(ctx: Context): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(
      'the credentials service is not available in this deployment, so no Agnes AI API key can be resolved',
    )
  }
  for (const ref of KEY_REFS) {
    const resolved = await credentials.resolve(ref)
    if (resolved !== undefined) return resolved.value
  }
  throw new Error(
    'no Agnes AI API key is configured. Store one as AGNES_AI_API_KEY in '
    + '$DSH_HOME/.credentials.yaml (under `refs`), or export the same name in the environment.',
  )
}
