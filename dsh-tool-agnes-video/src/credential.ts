/**
 * Credential helper for Agnes AI plugins.
 * Reads the AGNES_API_KEY from the credentials seam (stores → env → undefined).
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const KEY_REF = credentialRef('AGNES_API_KEY')

/**
 * Resolve the Agnes AI API key.
 * Throws if the key is not configured.
 */
export async function readCredential(ctx: Context): Promise<string> {
  const resolved = await ctx.credentials.resolve(KEY_REF)
  if (resolved === undefined) {
    throw new Error(
      'AGNES_API_KEY is not configured. ' +
      'Set it in ~/.dsh/.credentials.yaml or as the AGNES_API_KEY environment variable.'
    )
  }
  return resolved.value
}
