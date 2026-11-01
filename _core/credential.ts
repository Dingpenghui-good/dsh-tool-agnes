/**
 * Credential resolution shared by every Agnes plugin.
 *
 * Design contract — the plugin must follow whatever Agnes key DSH is already
 * configured with, never a hard-coded default:
 *
 *   DSH keeps the *reference* (an environment-variable name such as
 *   `AGNESCOM_API_KEY`) in the `llm-pi-ai` provider profile, and the *value*
 *   in the credential store. So the resolution order is:
 *
 *   1. the reference named by `config.apiKeyEnv` (explicit override), when set;
 *   2. the references declared by the Agnes providers in DSH's `llm-pi-ai`
 *      settings (`providers.*.apiKeyEnv`), in declaration order;
 *   3. legacy names (`AGNES_AI_API_KEY`, then `AGNES_API_KEY`), kept only so
 *      an unconfigured deployment still works.
 *
 * Every candidate is resolved through `ctx.credentials`, so rotation takes
 * effect on the next call with no restart. The first candidate that resolves
 * to a non-empty value wins; a candidate whose reference is unconfigured is
 * skipped rather than reported as a failure, which is what lets a stale legacy
 * name coexist with a live provider-declared one.
 *
 * @module dsh-tool-agnes/core/credential
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Settings namespace owned by the `llm-pi-ai` adapter. Its `providers` dict is
 * keyed by provider route and each profile carries `apiKeyEnv`.
 */
const LLM_PI_AI_NS = 'llm-pi-ai'

/**
 * Provider routes that speak to the Agnes gateway. Route ids are permanent, so
 * this list only seeds the order; DSH remains authoritative for which routes
 * actually exist.
 */
const AGNES_PROVIDER_PREFIX = 'agnes'

/** Legacy references, tried last so a configured deployment wins. */
const LEGACY_KEY_REFS = ['AGNES_AI_API_KEY', 'AGNES_API_KEY'] as const

/** One candidate reference and where it came from, for diagnostics. */
export interface KeyCandidate {
  /** Reference name resolved through the credential seam. */
  ref: string
  /** Why this candidate was considered. */
  origin: 'config' | 'provider' | 'legacy'
}

/** What the caller may supply to steer resolution. */
export interface CredentialOptions {
  /** Explicit reference name; overrides provider discovery when set. */
  apiKeyEnv?: string
}

/** One resolved key plus the reference it came from. */
export interface ResolvedKey {
  /** The non-empty secret value. */
  value: string
  /** Reference name that supplied it. */
  ref: string
  /** Why this reference was chosen. */
  origin: KeyCandidate['origin']
}

/**
 * Read the `apiKeyEnv` values declared by Agnes providers in DSH settings.
 *
 * Settings access is optional and defensive: a deployment may mount no
 * settings service, the namespace may be absent, or a profile may omit
 * `apiKeyEnv`. Any of those yields an empty list rather than an error, because
 * provider discovery is an optimization over the legacy fallback, not a
 * requirement.
 *
 * @param ctx - plugin context, possibly carrying a settings service.
 * @returns candidate references in provider declaration order.
 */
function providerKeyRefs(ctx: Context): string[] {
  const refs: string[] = []
  let providers: unknown
  try {
    // The settings service is not part of this plugin's hard dependency set;
    // read it through the generic service accessors so an absent mount is
    // simply "no settings".
    const settings = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as
      | { read?: (ns: string) => unknown; get?: (ns: string) => unknown }
      | undefined
    if (settings === undefined) return refs
    const read = settings.read ?? settings.get
    if (typeof read !== 'function') return refs
    const section = read.call(settings, LLM_PI_AI_NS) as
      | { providers?: Record<string, { apiKeyEnv?: unknown }> }
      | undefined
    providers = section?.providers
  } catch {
    return refs
  }
  if (typeof providers !== 'object' || providers === null) return refs

  for (const [route, profile] of Object.entries(providers as Record<string, unknown>)) {
    if (!route.toLowerCase().startsWith(AGNES_PROVIDER_PREFIX)) continue
    if (typeof profile !== 'object' || profile === null) continue
    const env = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
    if (typeof env === 'string' && env.trim() !== '' && !refs.includes(env.trim())) {
      refs.push(env.trim())
    }
  }
  return refs
}

/**
 * Build the ordered candidate list without resolving anything.
 * @param ctx - plugin context.
 * @param options - caller overrides.
 * @returns candidates, highest priority first, de-duplicated.
 */
export function listKeyCandidates(ctx: Context, options: CredentialOptions = {}): KeyCandidate[] {
  const out: KeyCandidate[] = []
  const seen = new Set<string>()
  const push = (ref: string, origin: KeyCandidate['origin']): void => {
    const name = ref.trim()
    if (name === '' || seen.has(name)) return
    seen.add(name)
    out.push({ ref: name, origin })
  }

  const explicit = options.apiKeyEnv?.trim()
  if (explicit) push(explicit, 'config')
  for (const ref of providerKeyRefs(ctx)) push(ref, 'provider')
  // The legacy name stays last so an unconfigured deployment keeps working,
  // but a live provider-declared reference always outranks it.
  for (const ref of LEGACY_KEY_REFS) push(ref, 'legacy')
  return out
}

/**
 * Resolve the Agnes AI API key, preferring whatever DSH is configured with.
 *
 * @param ctx - plugin context carrying the optional `credentials` service.
 * @param options - caller overrides; `apiKeyEnv` wins when supplied.
 * @returns the first candidate that resolves to a non-empty value.
 * @throws Error when the credentials service is unavailable or nothing resolves.
 */
export async function readCredential(
  ctx: Context,
  options: CredentialOptions = {},
): Promise<string> {
  const resolved = await resolveCredential(ctx, options)
  return resolved.value
}

/**
 * Resolve the key together with the reference that supplied it, so error
 * messages and diagnostics can name the exact credential in use.
 *
 * @param ctx - plugin context carrying the optional `credentials` service.
 * @param options - caller overrides; `apiKeyEnv` wins when supplied.
 * @returns the key and its provenance.
 * @throws Error when the credentials service is unavailable or nothing resolves.
 */
export async function resolveCredential(
  ctx: Context,
  options: CredentialOptions = {},
): Promise<ResolvedKey> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(
      'the credentials service is not available in this deployment, so no Agnes AI API key can be resolved',
    )
  }

  const candidates = listKeyCandidates(ctx, options)
  const tried: string[] = []
  for (const candidate of candidates) {
    try {
      const value = await credentials.resolve(credentialRef(candidate.ref))
      if (value !== undefined && typeof value.value === 'string' && value.value !== '') {
        return { value: value.value, ref: candidate.ref, origin: candidate.origin }
      }
    } catch {
      // An invalid reference name must not abort the chain: a later candidate
      // may still be configured correctly.
    }
    tried.push(candidate.ref)
  }

  throw new Error(
    'no Agnes AI API key is configured. '
      + 'Configure an Agnes provider under the llm-pi-ai settings section with an `apiKeyEnv` reference '
      + '(for example AGNESCOM_API_KEY), then store that reference in $DSH_HOME/.credentials.yaml under `refs` '
      + 'or export it in the environment. '
      + `Candidates tried: ${tried.length > 0 ? tried.join(', ') : '(none)'}.`,
  )
}
