# _verify — 验证与测试

这些脚本用于确认插件在当前 DSH + 当前 Agnes API 下**真的可用**，而不是「看起来应该可用」。

## 1. 单元测试（零依赖）

`_core/` 是自包含的，可以从任意目录运行：

```powershell
node --test E:\dsh-workspace\dsh-tool-agnes\_verify\core.test.mjs
```

覆盖：轮询状态机（含真实的「首次轮询没有 `status` 字段」报文）、视频 URL 提取（顶层 `url` 与遗留 `metadata.url`）、`8n+1` 帧数规则、模型族判定、图片魔数探测、MP4 识别、**错误分类与可行动建议**、重试性判定、字节格式化。

> 使用 Node 内置测试运行器而非 vitest：`_core` 不依赖任何包，Node 22+ 原生剥离类型，
> 因此不需要为三个插件各建一套测试工程。

## 2. 运行时验收（真实调用）

先构建三个包，然后从**仓库内任意目录**运行——脚本按绝对路径加载构建产物，并从包自身的 `node_modules` 解析依赖，因此不需要 profile 目录：

```powershell
cd E:\dsh-workspace\dsh-tool-agnes
node _verify\runtime-acceptance.mjs
node _verify\session-image-check.mjs
```

覆盖 35 项断言：

| 组 | 内容 |
|----|------|
| 插件装载 | 三个包各自注册预期工具（`generate_image` / `generate_video` + `get_video_task` / `generate_img2vid`），输出 schema 通过 DSH 的 `assertSupportedJsonSchema`，`presentCall` 与 `render` 齐备 |
| 图片端到端 | **真实调用 Agnes 生图**，返回值通过 `validateJsonSchemaValue` 校验，渲染出 `[text, image]` |
| 视频任务读取 | 注入已settled/运行中的 job 快照，验证 `get_video_task` 的解析与 schema 一致性（不消耗配额） |
| 错误分类 | 8 种真实错误形态 → 分类 → 建议文案 |

## 3. 能力探测（针对线上 API）

| 脚本 | 作用 | 计费 |
|------|------|------|
| `api-probe.mjs` | 列出网关当前可用模型 | 免费 |
| `image-generate-probe.mjs` | 直接探测图片生成 | 当前免费 |
| `image-capability-probe.mjs` | 探测图生图 / 多参考 / 多输出是否被接受 | 当前免费 |
| `video-create-probe.mjs` | 探测视频任务创建（V2.0 与 2.5 两种形状） | V2.0 当前免费 |
| `img2vid-probe.mjs` | 端到端验证图生视频（生图 → 建任务 → 轮询） | 当前免费 |
| `attachment-to-url-probe.mjs` | 探测 `/v1/files` 端点与 `image` 字段是否接受 data URL | 会创建一个任务（V2.0 当前免费） |
| `image-source-check.mjs` | 图片来源解析的 11 项断言，含**用本地文件真实创建视频任务** | 会创建一个任务（V2.0 当前免费） |
| `session-image-check.mjs` | 会话图片链路的 7 项断言（含跨会话隔离、无图报错），并用**会话里的图片真实创建任务** | 会创建一个任务（V2.0 当前免费） |

`session-image-check.mjs` 需要一个真实的 DSH 附件存储（`$DSH_HOME/attachments`）来验证附件来源；其余脚本只依赖凭据。

⚠️ 探测脚本会真实消耗免费额度并可能触发 429，请勿连续运行。

## 最近一次运行结果

```
# node --test core.test.mjs
tests 11 / pass 11 / fail 0

# node image-source-check.mjs
PASS  local file path is inlined
PASS  attachment:26d7ca71e000… is inlined
PASS  a missing file fails before any provider call
PASS  an oversize image is refused with guidance
PASS  a LOCAL image (data URL) creates a real video task
ALL IMAGE-SOURCE CHECKS PASSED

# node session-image-check.mjs
PASS  the plugin subscribes to the session event feed
PASS  omitting image with no session image fails with guidance
PASS  the pasted image is resolved to an attachment reference
PASS  the pasted image is inlined into the request
PASS  a real provider task was created from the session image
PASS  the alias "latest" means the session image
PASS  an explicit unreadable source fails instead of falling back
ALL SESSION-IMAGE CHECKS PASSED

# node runtime-acceptance.mjs
PASS  @dingpenghui/agnes-image registers generate_image
PASS  @dingpenghui/agnes-video registers generate_video + get_video_task
PASS  @dingpenghui/agnes-img2vid registers generate_img2vid
PASS  generate_image: value matches its output schema
PASS  generate_image: renders [text, image]
PASS  get_video_task: reports completed URL
PASS  error 400 {"message":"images is not supported by tex → unsupported-field
...
ALL ACCEPTANCE CHECKS PASSED
```

## 探测得到的服务端事实

| 探测 | 结果 |
|------|------|
| `POST /images/generations` + `image: <url>` | 400 `upstream_error`（网关未把该字段识别为图生图） |
| `POST /images/generations` + `images: [...]` | 400 `images is not supported by text image queue` |
| `POST /images/generations` + `n: 2` | 400 `n must be 1` |
| `POST /v1/videos` + `image: <url>` (V2.0) | **200**，轮询报文 `mode=ti2vid`、`image=set` |
| `GET`/`POST /v1/files` | 端点不存在（被路由到通配 chat 路径） |
| `POST /v1/videos` + `image: "data:image/jpeg;base64,…"` | **200** —— data URL 与公网 URL 等价 |

结论：

- **图生图/图像编辑在当前网关不可用**；
- **图生视频可用**，且图片**不必公网可达**——本地文件与 DSH 附件会由插件内联为 data URL；
- **GUI 里粘贴/上传的图片也可直接引用**：模型拿不到 `attachmentId`，由插件订阅 `session/event` 自行索引，`image` 参数可省略。
