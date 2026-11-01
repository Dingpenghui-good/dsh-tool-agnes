// 验证 429 滑动窗口退避逻辑
// `_core/` 在仓库根，pnpm 不在那里装 node_modules，需要钩子把宿主包解析到本子包。
import { register } from 'node:module'

register('./host-resolver.mjs', import.meta.url)

const { AgnesApiError } = await import('../../_core/errors.ts')
const {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  RateLimiter,
  backoffDelay,
  limiterFor,
  parseRetryAfterMs,
  policyFromConfig,
  resetLimiters,
} = await import('../../_core/rate-limit.ts')
const { agnesJson } = await import('../../_core/http.ts')

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

// ─────────────── 1. 滑动窗口主动限速 ───────────────
{
  resetLimiters()
  const limiter = new RateLimiter(3, 400)
  const signal = new AbortController().signal
  const t0 = Date.now()
  const waits = []
  for (let i = 0; i < 6; i++) waits.push(await limiter.acquire(signal))
  const elapsed = Date.now() - t0

  check('前 3 次立即放行', waits.slice(0, 3).every((w) => w < 50), `waits=${JSON.stringify(waits)}`)
  // 第 4~6 次必须等窗口滑出，总耗时至少 ~一个窗口
  check('第 4 次起等待窗口滑出', waits[3] > 0 && elapsed >= 350, `elapsed=${elapsed}ms`)
  check('窗口内计数不超过上限', limiter.used <= 3, `used=${limiter.used}`)
}

// ─────────────── 2. 退避计算 ───────────────
{
  const d1 = backoffDelay(1, undefined, 1000, 60000, 0)
  const d2 = backoffDelay(2, undefined, 1000, 60000, 0)
  const d3 = backoffDelay(3, undefined, 1000, 60000, 0)
  check('指数退避递增', d1 <= d2 && d2 <= d3, `d1=${d1} d2=${d2} d3=${d3}`)
  check('首次退避落在抖动带 [500,1000]', d1 >= 500 && d1 <= 1000, `d1=${d1}`)
  check('退避受上限约束', backoffDelay(99, undefined, 1000, 5000, 0) <= 5000)

  // Retry-After 优先
  check('Retry-After 优先于指数退避', backoffDelay(5, 2500, 1000, 65000, 0) === 2500)
  check('Retry-After 受上限约束', backoffDelay(1, 999999, 1000, 60000, 0) <= 60000)

  // 回归：本地窗口短于网关窗口时，退避必须至少等满网关窗口
  // （实测曾因 10s 本地 / 60s 网关的不匹配丢掉 12 次中的 5 次）
  const shortLocal = backoffDelay(1, undefined, 1000, 60000, 60000)
  check('退避不低于网关窗口', shortLocal >= 60000, `=${shortLocal}`)
  const withHint = backoffDelay(1, 3000, 1000, 65000, 60000)
  check('Retry-After 短于网关窗口时仍等满窗口', withHint >= 60000, `=${withHint}`)
}

// ─────────────── 3. Retry-After 解析 ───────────────
{
  const mk = (h) => new Response('', { status: 429, headers: h ? { 'retry-after': h } : {} })
  check('解析秒数', parseRetryAfterMs(mk('7')) === 7000)
  check('缺 header 返回 undefined', parseRetryAfterMs(mk(null)) === undefined)
  check('非法值返回 undefined', parseRetryAfterMs(mk('abc')) === undefined)
  const future = new Date(Date.now() + 5000).toUTCString()
  const fromDate = parseRetryAfterMs(mk(future))
  check('解析 HTTP 日期', fromDate > 3000 && fromDate <= 6000, `${fromDate}`)
}

// ─────────────── 4. limiterFor 按 key 共享 ───────────────
{
  resetLimiters()
  const a1 = limiterFor('key-a', 6)
  const a2 = limiterFor('key-a', 6)
  const b = limiterFor('key-b', 6)
  check('同一 key 共享 limiter', a1 === a2)
  check('不同 key 独立 limiter', a1 !== b)
}

// ─────────────── 5. agnesJson 遇 429 自动重试 ───────────────
{
  resetLimiters()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls <= 2) {
      return new Response(
        JSON.stringify({ error: { message: "You've reached the API rate limit for free users." } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })
  }
  try {
    const result = await agnesJson({
      apiKey: 'test-key-rl',
      url: 'https://example.invalid/v1/test',
      signal: new AbortController().signal,
      rateLimit: { requestsPerWindow: 0, maxRetries: 3, baseDelayMs: 20, maxDelayMs: 50 },
    })
    check('429 后自动重试并成功', result.ok === true && calls === 3, `calls=${calls}`)
  } catch (e) {
    check('429 后自动重试并成功', false, e.message)
  }
}

// ─────────────── 6. 429 重试耗尽后抛出 ───────────────
{
  resetLimiters()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(
      JSON.stringify({ error: { message: 'rate limited' } }),
      { status: 429 },
    )
  }
  try {
    await agnesJson({
      apiKey: 'test-key-exhaust',
      url: 'https://example.invalid/v1/test',
      signal: new AbortController().signal,
      rateLimit: { requestsPerWindow: 0, maxRetries: 2, baseDelayMs: 10, maxDelayMs: 20 },
    })
    check('重试耗尽后抛出 AgnesApiError', false, '未抛出')
  } catch (e) {
    check('重试耗尽后抛出 AgnesApiError', e instanceof AgnesApiError && e.isRateLimit, `calls=${calls}`)
    check('尝试次数 = maxRetries + 1', calls === 3, `calls=${calls}`)
  }
}

// ─────────────── 7. 非 429 错误不重试 ───────────────
{
  resetLimiters()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })
  }
  try {
    await agnesJson({
      apiKey: 'test-key-401',
      url: 'https://example.invalid/v1/test',
      signal: new AbortController().signal,
      rateLimit: { requestsPerWindow: 0, maxRetries: 3, baseDelayMs: 10 },
    })
    check('401 不重试', false, '未抛出')
  } catch (e) {
    const err = e
    check('401 不重试且立即抛出', calls === 1 && err instanceof AgnesApiError && err.kind === 'auth', `calls=${calls}`)
  }
}

// ─────────────── 8. 取消时停止等待 ───────────────
{
  resetLimiters()
  const controller = new AbortController()
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'rl' } }), { status: 429 })
  const p = agnesJson({
    apiKey: 'test-key-abort',
    url: 'https://example.invalid/v1/test',
    signal: controller.signal,
    rateLimit: { requestsPerWindow: 0, maxRetries: 5, baseDelayMs: 3000, maxDelayMs: 5000 },
  })
  setTimeout(() => controller.abort(), 100)
  const t0 = Date.now()
  try {
    await p
    check('取消中断退避', false, '未抛出')
  } catch (e) {
    const elapsed = Date.now() - t0
    check('取消中断退避等待', elapsed < 1500 && e.kind === 'cancelled', `elapsed=${elapsed}ms`)
  }
}

// ─────────────── 9. policyFromConfig ───────────────
{
  const policy = policyFromConfig({
    rateLimitRequestsPerWindow: 6,
    rateLimitWindowMs: 60000,
    rateLimitMaxRetries: 4,
    rateLimitBaseDelayMs: 3000,
  })
  check(
    'policyFromConfig 映射正确',
    policy.requestsPerWindow === 6 && policy.windowMs === 60000
      && policy.maxRetries === 4 && policy.baseDelayMs === 3000,
  )
  check('默认值常量合理', DEFAULT_BASE_DELAY_MS === 3000 && DEFAULT_MAX_DELAY_MS === 60000)
}

// ─────────────── 10. requestsPerWindow=0 关闭限速 ───────────────
{
  resetLimiters()
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
  }
  const t0 = Date.now()
  for (let i = 0; i < 8; i++) {
    await agnesJson({
      apiKey: 'test-key-off', url: 'https://example.invalid/v1/t',
      signal: new AbortController().signal,
      rateLimit: { requestsPerWindow: 0 },
    })
  }
  check('requestsPerWindow=0 时不限速', Date.now() - t0 < 200 && calls === 8, `elapsed=${Date.now() - t0}ms calls=${calls}`)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
