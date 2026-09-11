# dsh-tool-agnes 优化方案与实施状态

> 本文件同时是**方案**与**施工记录**。所有结论都来自对 Agnes 线上 API 的真实调用与对 DSH `0.1.5-rc.2` 契约的核对。

---

## 0. 实施状态总览

| # | 优化项 | 状态 | 结果 |
|---|--------|------|------|
| A | 视频异步化（`ctx.jobs`） | ✅ 已实施 | 单次调用 272 秒 → 约 1 秒 |
| A+ | 任务查询工具 `get_video_task` | ✅ 已实施 | 幂等读取，返回 URL + 本地副本 |
| B | 消除 `video`/`img2vid` 重复 | ✅ 已实施 | 抽出 `_core/`，构建内联 |
| C | 图片免公网 URL（data URL 内联） | ✅ 已实施 | 本地文件与 DSH 附件可直接驱动 img2vid |
| D | 产物落盘 | ✅ 已实施 | 完成后下载进附件存储 |
| E | 图像编辑 / 图生图 | ❌ 不可行 | **网关实测拒绝**，见 §3.1 |
| C | 图片免公网 URL（data URL 内联） | ✅ 已实施 | 本地文件与 DSH 附件直接可用，见 §3.2 |
| C+ | GUI 粘贴的图片可直接引用 | ✅ 已实施 | `image` 可省略，插件从会话索引取图，见 §3.3 |
| F | 自定义工具卡片 | ✅ 已实施 | 三个工具都有 `presentCall`/`presentResult` |
| G | 错误分类与可行动提示 | ✅ 已实施 | 10 类失败 + `Next step:` 建议 |
| G | 单元测试 | ✅ 已实施 | `node --test`，10 项，零依赖 |
| G | 契约探测 | ✅ 已实施 | `_verify/*-probe.mjs` 五个探测脚本 |
| G | 成本可见性 | ⚠️ 部分 | 2.5 模型的计费已写进工具描述与文档，未做运行时提示 |

---

## 1. 已实施的优化

### 1.1 视频异步化（收益最大）

**问题**：`awaitVideoTask` 在工具执行体内同步轮询。实测一次 8 秒 1080p 出片耗时 **272 秒**，这期间 agent 回合被占满，用户看不到进度。

**实现**：`_core/video-job.ts` 用 DSH 自带的 `ctx.jobs` 注册后台任务。

```ts
ctx.jobs.start({
  kind: AGNES_VIDEO_KIND,        // 'agnes-video' → job id 形如 agnes-video-1
  label: `Agnes video: ${prompt.slice(0, 60)}`,
  owner: exec.agent,             // 按 session 鉴权
  run() {
    const done = (async () => ({
      status: 'completed',
      detail: settled.state,
      output: JSON.stringify(result),   // final-output 生产者 → 读取幂等
    }))()
    return { cancel: () => controller.abort(), done }
  },
})
```

三个设计选择：

- **不提供 `readOutput`**，使其成为 final-output 生产者。这样 `get_video_task` 的读取是**幂等**的，可被模型反复调用而不会消费掉结果。
- **`cancel` 只 abort 控制器**，不吞掉正在进行的轮询；`done` 一定会 settle。
- **`start` 失败时降级**：若所在 composition 没有 job controller，工具仍返回 `taskId` 并在文本里说明「未自动跟踪」，而不是让整次调用失败。

**验证**：`_verify/runtime-acceptance.mjs` 注入 mock `ctx.jobs`，确认异步路径返回 `status: 'queued'` + `jobId`，且 `get_video_task` 对 running/settled 两种快照都返回符合 schema 的值。

### 1.2 消除重复（`_core/`）

改造前 `dsh-tool-agnes-video/src/client.ts` 与 `dsh-tool-agnes-img2vid/src/client.ts` 是**逐字节相同的 12,758 字节**。

**方案选择**：没有采用「合并为单包」（会破坏现有包名与 profile 配置），而是在仓库内建 `_core/` 共享源码目录，三个包用相对路径导入，tsdown 构建时内联：

```
//#region ../_core/credential.ts
//#region ../_core/errors.ts
//#region ../_core/http.ts
//#region ../_core/video.ts
```

**收益**：单一事实来源；运行时不引入第四个包；现有 profile 配置零改动。

**代价**：`_core/` 位于包目录之外，因此需要两处配合——

1. 每个包的 `tsconfig.json` 把 `../../_core/**/*` 纳入 `include`，并加 `paths` 让 `_core` 里的 `@deepseek-ai/*` 能解析到本包的 `node_modules`：

   ```json
   "baseUrl": ".",
   "paths": { "@deepseek-ai/*": ["./node_modules/@deepseek-ai/*"] }
   ```

2. 由于 `_core` 现在只依赖**每个包都必须具备**的包，`_core/media.ts` 不再从 `@deepseek-ai/dsh-attachment` 导入 `ImageMediaType`，而是自带结构等价的 `RasterMediaType`——视频插件因此不需要为了读四个魔数字节而依赖附件包。

### 1.3 产物落盘

视频完成后下载进附件存储（`ctx.attachments.saveFile`），随结果返回 `attachment: { attachmentId, name, bytes }`。

落盘是**尽力而为**：下载或写入失败时仍返回 provider URL，并把原因放进 `persistError` 字段，绝不因为存储问题而丢失一个已经渲染完成的视频。实测一个 8 秒 1080p 视频约 **2.65 MB**。

### 1.4 错误分类与可行动建议

原始报文 `Agnes API error 400: images is not supported by text image queue` 对模型没有可操作性。现在每种失败都被分类并附带 `Next step:`：

| 分类 | 触发 | 建议文案（节选） |
|------|------|------------------|
| `auth` | 401 | 把 `AGNES_AI_API_KEY` 写进 `.credentials.yaml` 的 `refs` |
| `rate-limit` | 429 | **不要立即重试**，等额度窗口重置或升级 Token Plan |
| `unsupported-field` | `... is not supported by ...` | 该字段已不被接受，**移除它而不是原样重试** |
| `upstream` | `type: upstream_error` | 网关无法把请求路由到模型，通常是请求形状不对 |
| `server` | 5xx | 通常是瞬时的，短暂停顿后重试一次（唯一 `retryable` 的分类） |
| `network` / `timeout` / `cancelled` / `malformed` / `invalid-request` / `forbidden` | — | 各自的具体下一步 |

轮询循环据此改进：**非瞬时的失败（限流、鉴权）立即抛出**，只有 `retryable` 的才计入 `maxConsecutiveFailures` 重试预算。

### 1.5 工具卡片

三个工具都实现了纯函数投影（可在回放中安全调用）：

- `presentCall`：`generate_image` 显示尺寸档位与提示词；视频工具显示模型、时长、及该模型族实际使用的尺寸参数。
- `presentResult`：替换标题为可读文案，并把结果内容交给 UI 渲染。

### 1.6 工程化

- **单元测试**：`node --test _verify/core.test.mjs`，10 项，零依赖。覆盖状态机、URL 提取、帧数规则、魔数探测、错误分类、重试性、字节格式化。
  > 用 Node 内置 runner 而非 vitest：`_core` 不依赖任何包，Node 22+ 原生剥离类型，无需为三个包各建一套测试工程。
- **运行时验收**：35 项断言，含一次真实生图与输出 schema 一致性校验。
- **契约探测**：五个探测脚本，用于在 Agnes 再次静默收紧参数时快速定位。

---

## 2. 未实施但仍有价值

### 2.1 成本可见性（部分）

2.5 系列视频按秒计费（720P `$0.025/秒`、1080P/1K `$0.040/秒`、2K `$0.055/秒`），而当前 Key 是免费额度。目前计费信息写在工具描述与文档里，**尚未做运行时提示**。

建议：加 `warnOnBillableModel` 配置，当选择的模型属于计费族时，在返回文本里加一行预估成本（`duration × 单价`）。

### 2.2 附件 → 公网 URL（方案 C）

见 §3.2。

### 2.3 后台任务的进度可见性

当前 job 是 final-output 生产者，运行时通过 `get_video_task` 只能看到 `processing`，看不到百分比。DSH 的 `tool-jobs` 工具（`job_output`）能看到 `detail`，但插件尚未把轮询进度写进去。

可选做法：把最新进度写进 `JobSnapshot.detail`（需要 producer 在运行期更新，当前 API 只在 terminal 提供 detail），或改成 stream 生产者（代价是读取变成消费式，失去幂等）。**当前选择保持幂等**，把进度留在 `generate_video` 的返回文本里。

---

## 3. 曾经的阻碍与结论

### 3.1 图像编辑 / 图生图 —— 服务端拒绝（实测）

Agnes 文档明确写着 Image 2.1/2.5 Flash「支持文生图、图生图和多图合成」。但针对当前网关的实测结果是：

| 请求形状 | 结果 |
|----------|------|
| `{ prompt, image: "<url>" }` | `400 upstream_error`：`LLM Provider NOT provided ... You passed model=agnes-image-2.5-flash` |
| `{ prompt, images: ["<url>"] }` | `400 invalid_request`：`images is not supported by text image queue` |
| `{ prompt, n: 2 }` | `400 invalid_request`：`n must be 1` |

`text image queue` 这个措辞说明当前暴露的是**纯文生图队列**；文档描述的是模型能力，可能对应尚未在此网关开放的队列或参数名。在找到正确形状之前，实现「图像编辑」工具只会得到一个必然 400 的工具。

**结论**：不实现。已把 `_verify/image-capability-probe.mjs` 留在仓库里，Agnes 开放该能力时可立即复测。

### 3.2 图片必须公网可访问 —— 已解决

**原问题**：`generate_img2vid` 要求图片是公网可达地址（Agnes 需要自己去取图），而 DSH 的图片是附件，`attachments.imageHostPath()` 只给本机路径。

**探测结论（决定性）**：

| 探测 | 结果 |
|------|------|
| `GET/POST /v1/files` | 不存在——被路由到通配 chat 路径，返回 `Model name not specified` |
| `POST /v1/videos` + `image: "data:image/jpeg;base64,…"`（422 KB 请求体） | **200**，任务创建成功 |

data URL 与公网 URL 等价，因此**不需要图床、上传端点或隧道**。

**实现**（`_core/image-source.ts`）：

| 来源 | 处理 |
|------|------|
| `https://…` | 原样透传（provider 自己取） |
| `data:image/…` | 原样透传 |
| `attachment:<id>` | 从内容寻址存储读出字节 → data URL |
| 本地路径 / `file://` | 读文件 → 魔数探测 → data URL |

三个设计细节：

- **先解析、后下单**：图片读不到时在创建 provider 任务**之前**失败，不会留下一个已计费的空任务。
- **`attachment:<id>` 的读取路径**：附件服务没有「按 id 读取」的接口（`readImage` 需要含 mediaType/尺寸的完整 ref），所以按内容寻址布局推导 `<DSH_HOME>/attachments/v1/objects/<id[0:2]>/<id>`。id 必须是十六进制摘要，否则明确拒绝。
- **体积上限**：默认 8 MB（`maxInlineImageBytes`）。base64 膨胀约 33%，超限时报错并给出「压缩或改用公网 URL」的下一步，而不是让请求神秘失败。

配套改动：`generate_image` 的摘要现在输出可复制的 `attachment:<id>`，使「生成图 → 做成视频」无需经过任何外部托管。

**验证**：`_verify/image-source-check.mjs` 11 项断言，其中包括**用本地文件（无公网 URL）真实创建一个视频任务并拿到 `video_id`**。

**仍未覆盖的场景**：~~用户在 GUI 里粘贴/上传的图片~~ —— 已在 1.4.0 解决，见 §3.3。

### 3.3 GUI 粘贴的图片无法被引用 —— 已解决（1.4.0）

**原问题**：用户粘贴/上传的图片以 `ImageBlock` 到达模型，模型看得到像素，但 `attachmentId` 是 host 元数据，模型永远收不到，所以无法指名这张图。

**调研过的路径**：

| 路径 | 结论 |
|------|------|
| 读 `session.surface` 找最近的 ImageBlock | `SessionSurface` 只暴露 `nodes`（seq 列表）与 `replaceGeneration`，取消息还要访问 private 的 log，不可行 |
| 让 DSH 把 attachmentId 附进模型上下文 | 需要改消息投影，不是插件能做的 |
| 按 id 读取附件 | `AttachmentStore` 没有 id-only 读取接口（`readImage` 需要完整 ref） |
| **订阅 `session/event`** | ✅ 事件携带完整 `UserMessage`，图片引用直接可取 |

**实现**（`_core/recent-images.ts` + `generate_img2vid`）：

1. 插件在 `apply` 时订阅 `session/event`，把每条 `user/message` 里的 `ImageBlock` 引用按会话分桶记住（每会话最近 8 张，最多 32 个会话，按最近使用淘汰）。
2. `generate_img2vid` 的 `image` 参数**变为可选**。省略、空串、或传 `latest`/`recent`/`last` 时，从索引取当前会话（`exec.agent.id`）最近一张图。
3. 用 `ctx.attachments.readImage(ref, signal)` 拿字节——走附件服务的**正式接口**（服务会校验引用与摘要），不依赖存储布局；只有模型显式传 `attachment:<id>` 时才需要推导路径。
4. 结果里回填 `image: "attachment:<id>"`，模型由此第一次获得这张图的 id，后续可反复引用。

**为什么是事件订阅而不是轮询 surface**：`session/event` 在事件提交后触发，payload 就是完整的 `UserMessage`，无需访问会话日志；而 surface 只有一个 seq 列表，拿消息需要 private log。

**机制核对**：DSH 内 120+ 处官方代码使用同一订阅点，其中 `packages/client/file-upload` 正是用 `event.type !== 'user/message'` 观察用户上传并做生命周期回收——与本实现同构，可作机制可得性的直接证据。

**不过滤 `source.kind`**：官方该处会过滤出真实用户消息，本实现刻意不过滤。这样 `generate_image` 经由 `deferContext` 注入的图片同样入索引，"把刚生成的那张图做成视频"也能走同一条路；顺序上最后到达的即为"最近一张"。

**已知边界**：constructor 种子（进程重启后从存储恢复的历史）不打事件流，所以重启前粘贴的图片不被索引。这是可接受的：该功能回答的是"把刚给我的这张图动起来"，永远是实时事件。

**验证**：`_verify/session-image-check.mjs`，7 项断言，含**用会话图片真实创建一次 provider 任务**，以及跨会话隔离、无图时的引导性报错、显式来源失败时不回退。

---

## 4. 使用指南

### 4.1 模型怎么选

```
静态图 ────────────────► generate_image，默认 agnes-image-2.5-flash（当前免费）
文本驱动的视频 ────────► generate_video，默认 agnes-video-v2.0（免费）
让一张公网图动起来 ────► generate_img2vid + imageUrl
```

`agnes-video-2.5*` 按秒计费，且当前免费 Key 直接 `429`。除非已升级 Token Plan，否则保持 `agnes-video-v2.0`。

### 4.2 异步工作流

```
1. generate_video { prompt: "a paper boat drifting downstream, slow dolly in" }
   ← { taskId, jobId: "agnes-video-1", status: "queued" }
2. （等待）
3. get_video_task { jobId: "agnes-video-1" }
   ← { status: "completed", videoUrl, attachment }
```

要点：

- 返回 `queued` 后**不要**重新发起同一次生成，那会重复计费。
- `get_video_task` 幂等，可以放心多读几次。
- 任务完成时 DSH 会通知；也可以用内置的 `job_output` 工具查同一个 job。
- 需要旧行为（工具内阻塞等待）时，把配置改为 `awaitCompletion: true`。

### 4.3 参数建议

**图片**

| 场景 | size | ratio | 实测耗时 |
|------|------|-------|----------|
| 快速草稿 | `1K` | `1:1` | ~10 秒 |
| 横版封面 | `2K` | `16:9` | ~20 秒 |
| 竖版短视频 | `2K` | `9:16` | ~20 秒 |

**视频**

- 时长：`duration: 8` @ 24fps → 193 帧，实测 272 秒出片。建议 ≤ 10 秒。
- 分辨率：请求 `1920x1080` 会被吸附为 `1920x1088`（预设 1080p/16:9），返回值里 `sizeAdjustment` 会说明——正常行为。
- 帧数上限 441（≈18.4 秒 @24fps）。

### 4.4 提示词模板

**图片**（英文、具体）：

```
<主体>, <动作/状态>, <环境>, <光线>, <镜头/视角>, <风格/画质>
例：a red fox curled asleep on moss, misty pine forest at dawn,
    soft rim light through branches, eye-level close shot,
    photorealistic, 4k, shallow depth of field
```

**视频**（必须写清**运动**）：

```
<主体动作> + <镜头运动> + <环境/氛围>
例：a paper boat drifting downstream, slow dolly-in following the boat,
    clear forest stream, morning light, cinematic
```

镜头词：`static shot` / `slow dolly in` / `panning left` / `crane up` / `tracking shot` / `handheld`。

服务端本身会带一份默认 negative prompt（见轮询报文 `request_params.negative_prompt`），一般无需重复。

### 4.5 故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `no Agnes AI API key is configured` | 凭据缺失 | 在 `.credentials.yaml` 的 `refs` 下写 `AGNES_AI_API_KEY` |
| `400 ... is not supported by text image queue` | 请求带了不被支持的字段 | 已修复；改代码时勿加回 `stream`/`format`/`images` |
| `429 rate_limit_exceeded` | 免费额度限流 | 等待或升级；**不要立即重试** |
| `generate_video` 返回 `queued` 后没有下文 | 后台任务未被跟踪 | 检查 base bundle 是否装载 `dsh-jobs-local`；返回文本会说明 |
| `get_video_task` 报未知 job | job 属于别的 session | job 按 owner session 鉴权，只能在创建它的会话里读 |
| 任务完成但无本地副本 | 落盘失败 | 看 `persistError`；provider URL 仍然可用 |
| 插件加载了但工具不出现 | 新增插件行需要重启 | `pnpm dsh web` |

---

## 5. 风险与对策

| 风险 | 说明 | 对策（现状） |
|------|------|--------------|
| Agnes 静默收紧参数 | 已撞上三次：`stream`、`format`、`images`/`n` | 契约探测脚本 + `unsupported-field` 分类明确指出「移除该字段」 |
| 模型改名 / 下架 | 旧代码硬编码的 `2.1` 与部署配置的 `2.5` 曾不一致 | 模型 id 走 Config，不在多处硬编码；`api-probe.mjs` 可列清单 |
| URL 过期 | `expires_at` 为 `null`，不可依赖 | 产物落盘（默认开启） |
| 免费额度政策变化 | 图片与 v2.0 视频当前免费 | 计费信息写入描述与文档；运行时提示待做（§2.1） |
| 长任务丢失 | 异步化后 taskId/jobId 随会话持久化 | job 由 DSH 注册表托管，完成后可反复读取 |
| 子包与运行时版本漂移 | 构建期装 `0.1.5-rc.1`，运行期解析 profile 的 `0.1.5-rc.2` | 依赖范围写 `^0.1.5-rc.1`；升级 DSH 后重跑验收脚本 |

---

## 6. 仍待决策

1. **是否加运行时成本提示**（§2.1）。
2. **是否需要视频进度可见性**（§2.3）——代价是放弃读取的幂等性。
