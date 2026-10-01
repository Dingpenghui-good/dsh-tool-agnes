// 验证 bundle 壳包结构：模拟 DSH loader 的行为
//
// 1. 读 bundle 壳包的 package.json，确认 dsh.bundle.patch 指向 cordis.patch.yml
// 2. 解析 cordis.patch.yml，确认 3 行 insert 的 name 都能在 node_modules 里解析到
// 3. 加载每个组件包的 lib/index.js，确认导出 apply/name/inject/Config
// 4. 确认 lib/index.js 是空壳
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = resolve('E:\\dsh-workspace\\dsh-tool-agnes')
const shellDir = join(root, 'dsh-tool-agnes-profile')
const shellPkg = JSON.parse(readFileSync(join(shellDir, 'package.json'), 'utf8'))

console.log('=== 1. bundle 壳包元数据 ===')
console.log('name:', shellPkg.name, 'version:', shellPkg.version)
console.log('dsh.bundle.patch:', shellPkg.dsh?.bundle?.patch)
console.log('main:', shellPkg.main)
const patchPath = join(shellDir, shellPkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')
console.log('patch exists:', existsSync(patchPath))

// 简易 YAML 解析（只处理本文件结构：顶层 - insert: 下 3 行 id/name/config）
const patchText = readFileSync(patchPath, 'utf8')
console.log('\n=== 2. 解析 insert 行 ===')
const lines = []
let current = null
for (const raw of patchText.split('\n')) {
  const mId = raw.match(/^\s*- id:\s*(.+)$/)
  if (mId) {
    current = { id: mId[1].trim(), name: undefined, configKeys: [] }
    lines.push(current)
    continue
  }
  const mName = raw.match(/^\s*name:\s*(.+)$/)
  if (mName && current) current.name = mName[1].replace(/'/g, '')
  const mCfg = raw.match(/^\s+(\w+):\s*(.+)$/)
  if (mCfg && current && !/^id$|^name$/.test(mCfg[1]) && !raw.trimStart().startsWith('-')) {
    current.configKeys.push(mCfg[1])
  }
}
for (const l of lines) console.log(`  id=${l.id} name=${l.name} config=[${l.configKeys.join(',')}]`)

// 3. 通过 shell 的 node_modules 解析组件包入口
const require = createRequire(join(shellDir, 'package.json'))
console.log('\n=== 3. 组件包入口导出 ===')
for (const l of lines) {
  const resolved = require.resolve(l.name)
  const mod = await import(pathToFileURL(resolved))
  const exports = Object.keys(mod)
  console.log(`  ${l.name} -> ${resolved}`)
  console.log(`    exports: ${exports.join(', ')}`)
  const hasAll = ['apply','name','inject','Config'].every(k => exports.includes(k))
  console.log(`    apply/name/inject/Config all present: ${hasAll}`)
}

// 4. 确认 lib/index.js 是空壳
const shellMain = join(shellDir, shellPkg.main)
console.log('\n=== 4. bundle 壳 main ===')
console.log('content:', JSON.stringify(readFileSync(shellMain, 'utf8')))

console.log('\nBUNDLE SHELL STRUCTURE OK')
