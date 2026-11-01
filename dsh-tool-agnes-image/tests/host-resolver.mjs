/**
 * Module resolver hook for the `_core/` tests.
 *
 * `_core/` sits at the workspace root, where pnpm installs no `node_modules`
 * (dependencies live in each sub-package). Node therefore cannot resolve the
 * bare host specifiers that `_core/*.ts` imports. This hook maps them onto the
 * copies pnpm already installed for the sub-package running the test, so the
 * tests exercise the real host packages instead of a hand-written stub.
 *
 * Register it before importing anything from `_core/`:
 *
 *   import { register } from 'node:module'
 *   register('./tests/host-resolver.mjs', import.meta.url)
 *
 * Then a bare import from `_core/` resolves against this sub-package's own
 * dependency tree — the same one `tsc` type-checks against.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
// The sub-package's own node_modules, beside its tests/ directory.
const LOCAL_MODULES = path.resolve(here, '..', 'node_modules')

/** Map one bare `@deepseek-ai/*` specifier onto this package's installed copy. */
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    const pkgDir = path.join(LOCAL_MODULES, ...specifier.split('/'))
    if (existsSync(pkgDir)) {
      const entry = path.join(pkgDir, 'lib', 'index.js')
      const target = existsSync(entry) ? entry : path.join(pkgDir, 'index.mjs')
      if (existsSync(target)) return nextResolve(pathToFileURL(target).href, context)
    }
  }
  return nextResolve(specifier, context)
}
