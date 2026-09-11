# @dingpenghui/agnes-image

DSH 插件：Agnes AI **文生图**，注册 `generate_image` 工具。

## 能力

- 调用 `POST /v1/images/generations`（默认模型 `agnes-image-2.5-flash`）
- 结果持久化为 DSH 附件，并在对话中**内联渲染图片**
- 支持 `1K/2K/3K/4K` 分辨率档位与 8 种宽高比
- 声明了 `presentCall` / `presentResult` 卡片投影

## 配置

```yaml
- id: tool-agnes-image
  name: '@dingpenghui/agnes-image'
  config:
    model: agnes-image-2.5-flash   # 或 agnes-image-2.1-flash / agnes-image-2.0-flash
    defaultSize: 1K                # 1K | 2K | 3K | 4K
    defaultRatio: 1:1              # 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 | 21:9
    persistAttachment: true        # 持久化到附件存储并内联渲染
    ferryContext: true             # PTC 子派发时把图片渡回外层结果
    timeoutMs: 240000              # 单次请求预算
```

凭据：`AGNES_AI_API_KEY`（回退 `AGNES_API_KEY`），位于 `$DSH_HOME/.credentials.yaml` 的 `refs` 下或同名环境变量。

## 工具参数

| 参数 | 类型 | 必填 | 默认 |
|------|------|------|------|
| `prompt` | string | ✅ | - |
| `size` | string | ❌ | 配置值（`1K`） |
| `ratio` | string | ❌ | 配置值（`1:1`） |

## 开发

```powershell
pnpm install
pnpm build                              # -> lib/
npx tsc -p tsconfig.json --noEmit
```

协议实现位于上层的 [`_core/`](../_core)，构建时内联进 `lib/`。

## 注意

Agnes 的文本图像队列**拒绝 `stream`、`format`、`images`，且 `n` 必须为 1**
（HTTP 400 `... is not supported by text image queue` / `n must be 1`）。
本插件只发送 `model` / `prompt` / `size` / `ratio`，请不要重新加回这些字段。
也正因如此，**图生图/图像编辑在本网关不可用**。

完整说明见 [上级 README](../README.md)；优化记录见 [OPTIMIZATION.md](../OPTIMIZATION.md)。

MIT
