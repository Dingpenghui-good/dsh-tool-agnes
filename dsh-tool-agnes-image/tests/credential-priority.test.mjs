// 验证 credential 解析优先级逻辑
// `_core/` 在仓库根，ppn 不在那里装 node_modules，需要钩子把宿主包解析到本子包。
import { register } from 'node:module'

register('./host-resolver.mjs', import.meta.url)

const { listKeyCandidates } = await import('../../_core/credential.ts')

function makeCtx(settingsSection) {
  return {
    get(name) {
      if (name === 'settings') {
        return {
          read(ns) {
            if (ns !== 'llm-pi-ai') return undefined
            return settingsSection
          },
        }
      }
      return undefined
    },
  }
}

const cases = [
  {
    name: 'DSH 配置了 agnescom/agnescn 两个 provider',
    settings: {
      providers: {
        agnescom: { baseURL: 'https://apihub.agnes-ai.com/v1', apiKeyEnv: 'AGNESCOM_API_KEY' },
        agnescn: { baseURL: 'https://api.agnes-ai.cn/v1', apiKeyEnv: 'AGNESCN_API_KEY' },
      },
    },
    expect: ['AGNESCOM_API_KEY', 'AGNESCN_API_KEY', 'AGNES_AI_API_KEY', 'AGNES_API_KEY'],
  },
  {
    name: '忽略非 agnes 的 provider',
    settings: {
      providers: {
        openai: { apiKeyEnv: 'OPENAI_KEY' },
        agnescom: { apiKeyEnv: 'AGNESCOM_API_KEY' },
      },
    },
    expect: ['AGNESCOM_API_KEY', 'AGNES_AI_API_KEY', 'AGNES_API_KEY'],
  },
  {
    name: 'provider 未写 apiKeyEnv 时跳过',
    settings: { providers: { agnescom: { baseURL: 'x' } } },
    expect: ['AGNES_AI_API_KEY', 'AGNES_API_KEY'],
  },
  {
    name: '无 settings 服务（降级到 legacy）',
    settings: undefined,
    expect: ['AGNES_AI_API_KEY', 'AGNES_API_KEY'],
  },
  {
    name: '重复引用去重',
    settings: {
      providers: {
        agnescom: { apiKeyEnv: 'AGNESCOM_API_KEY' },
        agnescom2: { apiKeyEnv: 'AGNESCOM_API_KEY' },
      },
    },
    expect: ['AGNESCOM_API_KEY', 'AGNES_AI_API_KEY', 'AGNES_API_KEY'],
  },
]

let failed = 0
for (const c of cases) {
  const got = listKeyCandidates(makeCtx(c.settings)).map((x) => x.ref)
  const ok = JSON.stringify(got) === JSON.stringify(c.expect)
  console.log(`${ok ? '✅' : '❌'} ${c.name}`)
  if (!ok) {
    console.log(`   expect: ${JSON.stringify(c.expect)}`)
    console.log(`   got   : ${JSON.stringify(got)}`)
    failed++
  }
}

// 显式 apiKeyEnv 最高优先级
const explicit = listKeyCandidates(
  makeCtx({ providers: { agnescom: { apiKeyEnv: 'AGNESCOM_API_KEY' } } }),
  { apiKeyEnv: 'CUSTOM_KEY' },
).map((x) => x.ref)
const explicitOk = explicit[0] === 'CUSTOM_KEY'
console.log(`${explicitOk ? '✅' : '❌'} 显式 apiKeyEnv 优先级最高 → ${explicit[0]}`)
if (!explicitOk) failed++

// 来源标注
const origins = listKeyCandidates(
  makeCtx({ providers: { agnescom: { apiKeyEnv: 'AGNESCOM_API_KEY' } } }),
).map((x) => `${x.ref}:${x.origin}`)
console.log(`   来源标注: ${origins.join(' | ')}`)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
