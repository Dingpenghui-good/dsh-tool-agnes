# v1.7.0 — 凭据解析改为跟随 DSH 配置的 Agnes key

## 问题

图像 / 视频工具此前把凭据名硬编码为 `AGNES_AI_API_KEY`（回退 `AGNES_API_KEY`），完全不读取用户在 DSH 中配置的 Agnes provider 凭据。

后果是：即使用户在 `llm-pi-ai` 设置段里正确配置了 `AGNESCOM_API_KEY` / `AGNESCN_API_KEY`，图像与视频工具仍然只认那个遗留的固定名字。该名字一旦失效（例如返回 `401 This token status is unavailable`），工具就会持续报错，而用户明明已经配好了可用的 key。

## 改动

凭据解析改为三层优先级，**优先跟随 DSH 已配置的 key**：

1. 插件配置 `apiKeyEnv`（新增，显式指定时最高优先）
2. DSH `llm-pi-ai` 设置段中 Agnes provider 声明的 `apiKeyEnv`，按 provider 声明顺序
3. 兼容回退：`AGNES_AI_API_KEY` → `AGNES_API_KEY`

### 具体实现（`_core/credential.ts`）

- 新增 `listKeyCandidates(ctx, options)`：只做候选排序、不去解析，便于诊断与测试
- 新增 `resolveCredential(ctx, options)`：解析出 key 并带回来源引用名
- `readCredential(ctx, options)`：保持原签名向后兼容，新增可选第二参数
- 从 `llm-pi-ai` 设置段读取 `providers.*.apiKeyEnv`，只挑选路由 id 以 `agnes` 开头的 provider
- 所有候选统一经 `ctx.credentials.resolve()` 解析，因此 key 轮换**无需重启即可生效**
- 未配置的引用会被**跳过而非报错**，使失效的遗留 key 与可用的新 key 能够共存
- 设置服务不可用、命名空间缺失或 profile 未写 `apiKeyEnv` 时，均优雅降级为空列表

### 各子包

三个工具包均新增可选配置项 `apiKeyEnv`（默认 `''`，即自动跟随 DSH 配置）：

```yaml
- id: tool-agnes-image
  name: '@dingpenghui/agnes-image'
  config:
    model: agnes-image-2.5-flash
    apiKeyEnv: AGNESCOM_API_KEY   # 可选：留空则自动读取 DSH 中的 Agnes provider 配置
```

## 验证

- 新增 `tests/credential-priority.test.mjs`，覆盖 6 项优先级场景，全部通过：
  - DSH 配置多个 Agnes provider 时的顺序
  - 忽略非 `agnes` 前缀的 provider
  - provider 未写 `apiKeyEnv` 时跳过
  - 无 settings 服务时降级到遗留名字
  - 重复引用去重
  - 显式 `apiKeyEnv` 优先级最高
- 三包 `tsdown` 构建通过，产物已确认包含新逻辑
- 类型检查通过

## 升级说明

仅新增可选配置，默认行为即自动跟随 DSH 配置，无需修改现有配置即可获得修复。

三包同步发布，版本号一致为 `1.7.0`。
