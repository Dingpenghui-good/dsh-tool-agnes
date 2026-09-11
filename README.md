# dsh-tool-agnes

Agnes AI 媒体生成插件集，为 DeepSeek Harness (DSH) 提供**文生图 / 文生视频 / 图生视频**三种能力。

当前版本：**1.4.0** —— 适配 DSH `0.1.5-rc.2`，针对 Agnes 线上 API 的真实行为做过调用验证，并完成三轮以「可靠性、可维护性、可用性」为目标的优化。

| 插件 | 包名 | 工具 |
|------|------|------|
| [dsh-tool-agnes-image](./dsh-tool-agnes-image) | `@dingpenghui/agnes-image` | `generate_image` |
| [dsh-tool-agnes-video](./dsh-tool-agnes-video) | `@dingpenghui/agnes-video` | `generate_video`、`get_video_task` |
| [dsh-tool-agnes-img2vid](./dsh-tool-agnes-img2vid) | `@dingpenghui/agnes-img2vid` | `generate_img2vid` |

三个包共用 [`_core/`](./_core) 中的协议实现（凭据、HTTP、错误分类、图片、视频状态机、后台任务），构建时内联进各自的 `lib/`，因此运行时不引入第四个包，也不存在协议逻辑的多份副本。

---

## 1. 1.4.0 / 1.3.0 / 1.2.0 做了什么

### 1.4.0：GUI 里粘贴的图片可以直接用

模型能**看到**用户粘贴的图片，却拿不到它的 `attachmentId`（那是 host 元数据），所以无法指名这张图。现在插件自己解决：

- 订阅 `session/event`，记住每条用户消息带来的图片引用（按会话分桶，最近 8 张 / 32 个会话）
- `generate_img2vid` 的 `image` 参数**变为可选**：省略（或传 `latest`/`recent`/`last`）时，自动使用当前会话最近一张图
- 解析出的引用会回填进结果（`attachment:<id>`），模型由此第一次知道这张图的 id

于是"粘贴图片 → 说把它动起来"直接可用，模型不需要 id：

```
用户：[粘贴一张图] 把它变成视频，镜头慢慢推近
AI  ：generate_img2vid { prompt: "slow push in" }   ← 不带 image
      → 插件自动取到刚粘贴的那张图 → 真实任务创建成功
```

`readImage` 走的是附件服务的正式接口（拿到的是完整 ref，字节由服务校验后返回），不依赖存储布局；只有模型显式传 `attachment:<id>` 时才需要推导路径。

### 1.3.0：解除「图片必须公网可访问」的限制

实测发现 `POST /v1/videos` 的 `image` 字段**接受 `data:` URL**，与公网 URL 等价。因此 `generate_img2vid` 的图片来源扩展为四类，本地图片会被自动内联进请求：

| 来源 | 写法 | 说明 |
|------|------|------|
| 公网 URL | `https://…` | 原样透传 |
| DSH 附件 | `attachment:<id>` | `generate_image` 会返回这个引用；直接复制即可 |
| 本地文件 | `E:\path\to\img.jpg` 或 `@` 引用 | 读文件 → 转 data URL |
| 内联数据 | `data:image/…;base64,…` | 原样透传 |

配套改动：`generate_image` 的摘要里现在输出可复制的 `attachment:<id>`；`img2vid` 在创建 provider 任务**之前**先解析图片，读不到就立即失败，不会产生一个已计费的空任务。

### 1.2.0：可靠性与可维护性

| 方向 | 改动 | 效果 |
|------|------|------|
| **视频异步化** | `generate_video` / `generate_img2vid` 默认不再阻塞，改为注册 DSH 后台任务并立即返回 | 单次调用从**实测 272 秒**降到约 1 秒；不再占用 agent 回合 |
| **任务查询** | 新增 `get_video_task` 工具 | 模型可在后续回合取回结构化结果（URL + 本地副本），幂等可重复读 |
| **产物落盘** | 视频完成后自动下载进 DSH 附件存储 | 不再依赖第三方 CDN 链接的隐含有效期 |
| **错误可行动化** | 新增错误分类层，每种失败附带 `Next step:` 建议 | `429` 明确告知「不要立即重试」；`400 ... is not supported` 直接指出字段已不被接受 |
| **工具卡片** | 三个工具都声明了 `presentCall` / `presentResult` | 待执行卡片显示模型与关键参数，而不是裸 JSON |
| **消除重复** | 抽出 `_core/`，`video` 与 `img2vid` 不再各自维护一份 12 KB 的客户端 | 协议修正只需改一处 |
| **工程化** | 零依赖单元测试 + 运行时验收 + 能力探测脚本 | 回归有据可依 |

---

## 2. 环境要求

| 项 | 要求 |
|----|------|
| DSH | `0.1.5-rc.2`（依赖声明 `^0.1.5-rc.1`，运行期解析到 profile 实际安装的版本） |
| Node.js | `>= 22`（开发机 24.x） |
| 凭据 | `AGNES_AI_API_KEY`（旧名 `AGNES_API_KEY` 仍兼容） |

凭据写入 `$DSH_HOME/.credentials.yaml`：

```yaml
refs:
  AGNES_AI_API_KEY: sk-xxxxxxxx
```

或使用同名环境变量。

---

## 3. 接入 DSH

`$DSH_HOME/profiles/web/package.json`：

```json
{
  "dependencies": {
    "@dingpenghui/agnes-image": "link:E:/dsh-workspace/dsh-tool-agnes/dsh-tool-agnes-image",
    "@dingpenghui/agnes-video": "link:E:/dsh-workspace/dsh-tool-agnes/dsh-tool-agnes-video",
    "@dingpenghui/agnes-img2vid": "link:E:/dsh-workspace/dsh-tool-agnes/dsh-tool-agnes-img2vid"
  }
}
```

`$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: tool-agnes-image
      name: '@dingpenghui/agnes-image'
      config:
        model: agnes-image-2.5-flash
        defaultSize: 1K
        defaultRatio: 1:1
        persistAttachment: true
        ferryContext: true
        timeoutMs: 240000
    - id: tool-agnes-video
      name: '@dingpenghui/agnes-video'
      config:
        model: agnes-video-v2.0
        pollIntervalMs: 5000
        timeoutMs: 900000
        maxConsecutiveFailures: 4
        ferryContext: true
        awaitCompletion: false     # 后台任务模式（推荐）
        persistVideo: true
    - id: tool-agnes-img2vid
      name: '@dingpenghui/agnes-img2vid'
      config:
        model: agnes-video-v2.0
        pollIntervalMs: 5000
        timeoutMs: 900000
        maxConsecutiveFailures: 4
        ferryContext: true
        awaitCompletion: false
        persistVideo: true
        maxInlineImageBytes: 8388608   # 本地图片内联上限（8 MB）
```

然后：

```powershell
cd $env:DSH_HOME\profiles\web
pnpm install            # 建立 link
cd E:\deepseek-harness
pnpm dsh web            # 重启后生效
```

> **必须重启**：`patchReload: live` 只对已挂载行的 `config` 变更做热重载；**新增插件行**需要重启进程才会装载。

---

## 4. 工具参考

### generate_image — 文生图

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `prompt` | string | ✅ | - | 图像描述；英文、具体（主体/构图/光线/风格）效果最好 |
| `size` | string | ❌ | `1K` | `1K` / `2K` / `3K` / `4K` |
| `ratio` | string | ❌ | `1:1` | `1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3` `21:9` |

返回 `url` + `attachment`，并在对话中**内联渲染图片**。产物可直接作为 `generate_img2vid` 的输入来源（需为公网 URL）。

### generate_video — 文生视频

| 参数 | 类型 | 默认 | 适用模型 |
|------|------|------|----------|
| `prompt` | string | - | 全部（必填） |
| `model` | string | `agnes-video-v2.0` | 全部 |
| `duration` | integer | `8` | 全部（秒） |
| `width` / `height` | integer | `1920` / `1080` | 仅 V2.0 |
| `frameRate` | integer | `24` | 仅 V2.0 |
| `size` | string | `720P` | 仅 2.5 系列 |
| `aspectRatio` | string | `16:9` | 仅 2.5 系列 |
| `seed` / `negativePrompt` | - | - | 全部 |

**默认非阻塞**：立即返回 `taskId` 与 `jobId`，渲染在后台进行。

### get_video_task — 读取后台任务

| 参数 | 类型 | 必填 |
|------|------|------|
| `jobId` | string | ✅ |

读取是**幂等**的：任务未结束返回 `processing`，结束后返回 `completed` + `videoUrl` + 本地 `attachment`。

### generate_img2vid — 图生视频

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image` | string | ❌ | **省略即用当前会话最近一张图**（用户刚粘贴/上传的那张）。也可显式传：公网 `http(s)://` URL、`attachment:<id>`、本地文件路径、`data:` URL。本地/附件/会话来源都会**自动内联**进请求 |
| `prompt` | string | ❌ | 运动描述 |
| 其余 | - | ❌ | 同 `generate_video` |

返回里带 `imageResolution`（`remote-url` / `inline`），说明该图片是 provider 自己去取还是被内联进请求；`image` 字段回填实际使用的引用，便于后续再次使用。

> 两个视频工具职责互斥：纯文本驱动用 `generate_video`，动画化已有图片用 `generate_img2vid`。

---

## 5. 实测 API 事实（2026-09 线上）

代码按这些**实测结论**实现，而非按文档推断：

| 事实 | 影响 |
|------|------|
| `/v1/images/generations` 拒绝 `stream`、`format` | 旧版硬编码 `stream:false`，必然 400 |
| 该端点拒绝 `images`（图生图）与 `n != 1` | **图生图/图像编辑在当前网关不可用**，插件不提供该工具 |
| 图片响应只有 `data[].url` / `data[].b64_json`，**没有** `width/height/size/ratio` | 摘要不能依赖这些字段 |
| 视频轮询**早期没有 `status`**，只有 `internal_status` | 状态需多字段联合判定 |
| 视频完成时 URL 在**顶层 `url`**，不是 `metadata.url` | 旧版永远取不到视频地址 |
| `8n+1` 帧数按**最近值**取整（8s@24fps → 193 帧），上限 441 | 向下取整会得到偏短的视频 |
| 视频推理实测 **272 秒**（193 帧 @1080p） | 这是异步化的直接依据 |
| `POST /v1/videos` 带 `image` 字段有效（`mode=ti2vid`） | `generate_img2vid` 可用 |
| `POST /v1/videos` 的 `image` **接受 `data:` URL**，与公网 URL 等价 | 本地图片/DSH 附件可直接内联，无需图床 |
| `/v1/files` 上传端点**不存在**（被路由到通配 chat 路径） | 只能走 URL 或 data URL，不能上传换 file id |
| 请求 `1920x1080` 被吸附为 `1920x1088` | 正常行为，返回值带 `sizeAdjustment` 说明 |
| 免费 Key 对 2.5 系列视频返回 `429` | 默认模型选免费的 `agnes-video-v2.0` |
| 图片接口当前免费 | 2.5 视频按秒计费 |

---

## 6. 验证

```powershell
# 先构建
cd E:\dsh-workspace\dsh-tool-agnes\dsh-tool-agnes-image
pnpm install && pnpm build      # 三个包各执行一次

# 单元测试（零依赖）
node --test E:\dsh-workspace\dsh-tool-agnes\_verify\core.test.mjs

# 运行时验收：真实生图一次，并校验输出 schema
node E:\dsh-workspace\dsh-tool-agnes\_verify\runtime-acceptance.mjs

# 会话图片链路：真实创建一次视频任务
node E:\dsh-workspace\dsh-tool-agnes\_verify\session-image-check.mjs

# 图片来源解析：URL / 附件 / 本地路径
node E:\dsh-workspace\dsh-tool-agnes\_verify\image-source-check.mjs
```

脚本从**任意目录**可运行：它们按绝对路径加载构建产物，并从包自身的 `node_modules` 解析依赖。

构建与类型检查：

```powershell
cd E:\dsh-workspace\dsh-tool-agnes\dsh-tool-agnes-image
pnpm install
pnpm build                              # -> lib/
npx tsc -p tsconfig.json --noEmit
```

详见 [`_verify/README.md`](./_verify/README.md)。

---

## 7. 目录结构

```
dsh-tool-agnes/
├── _core/                       # 三个包共享的协议实现（构建时内联）
│   ├── credential.ts            # AGNES_AI_API_KEY / AGNES_API_KEY 解析
│   ├── errors.ts                # 错误分类 + 可行动建议
│   ├── http.ts                  # 统一请求、超时、下载、可取消 sleep
│   ├── image.ts                 # 图片端点客户端
│   ├── image-source.ts          # 图片来源解析：URL / 附件 / 本地路径 / data URL
│   ├── media.ts                 # 魔数探测、data URL 编码、MP4 识别、字节格式化
│   ├── recent-images.ts         # 会话图片索引（用户粘贴/上传的图，按会话分桶）
│   ├── types.ts                 # 线上报文类型
│   ├── video.ts                 # 视频任务创建 + 轮询状态机
│   └── video-job.ts             # DSH 后台任务（异步渲染 + 落盘 + 读取）
├── dsh-tool-agnes-image/        # 文生图（src/index.ts + cordis.yml + lib/）
├── dsh-tool-agnes-video/        # 文生视频 + 任务查询
├── dsh-tool-agnes-img2vid/      # 图生视频
├── _verify/                     # 单元测试、运行时验收、能力探测
├── README.md
└── OPTIMIZATION.md              # 优化方案与实施状态
```

---

## 8. 已知限制

1. **图生图 / 图像编辑不可用**：网关的文本图像队列实测拒绝 `images` 与 `image` 形状，插件不提供该能力。
2. **2.5 系列视频在当前 Key 上级别不足**：返回 `429`，需要 Token Plan。
3. **后台任务依赖 base bundle 的 `dsh-jobs-local`**：缺失时会退化为「只报 taskId、不自动跟踪」，工具仍可用。
4. **内联图片有体积上限**：默认 8 MB（`maxInlineImageBytes`）。base64 会膨胀约 33%，超过上限的图片请先压缩或改用公网 URL。
5. **会话图片窗口只覆盖本次进程内到达的图片**：DSH 重启后，重启之前粘贴的图片不再被索引（重启后新粘贴的图正常）。这是刻意的——该功能回答的是"把刚给我的这张图动起来"。
6. **视频 URL 有效期未公开**：已通过落盘缓解，但落盘可被 `persistVideo: false` 关闭。

---

## License

MIT
