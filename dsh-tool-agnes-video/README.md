# @dingpenghui/agnes-video

DSH 插件：Agnes AI **文生视频**，注册 `generate_video` 与 `get_video_task` 两个工具。

## 能力

- 调用 `POST /v1/videos` 创建异步任务，再轮询 `GET /agnesapi?video_id=…`
- **默认非阻塞**：渲染以 DSH 后台任务（`ctx.jobs`）运行，调用立即返回 `taskId` + `jobId`
- 同时支持两代请求形状：
  - **2.5 系列**（默认 `agnes-video-2.5-flash`，现价 `$0/秒`）：`seconds` / `mode` / `size` / `aspect_ratio`
  - **V2.0**（`agnes-video-v2.0`，旧形状）：`width` / `height` / `num_frames` / `frame_rate`
- 轮询状态机综合 `status` / `internal_status` / `completed_at` / `error` 判定；URL 取**顶层 `url`**
- 产物下载进附件存储，返回 `attachment`
- 非瞬时失败（限流、鉴权）立即抛出，只有瞬时错误才计入重试预算

## 配置

```yaml
- id: tool-agnes-video
  name: '@dingpenghui/agnes-video'
  config:
    model: agnes-video-2.5-flash # 或 agnes-video-2.5 / -2.5-fast / agnes-video-v2.0
    pollIntervalMs: 5000
    timeoutMs: 900000            # 后台预算；实测一次 8 秒 1080p 约 272 秒
    maxConsecutiveFailures: 4
    ferryContext: true
    awaitCompletion: false       # true 则回到工具内阻塞等待
    persistVideo: true           # 完成后下载到附件存储
```

凭据：`AGNES_API_KEY` 或首选 `AGNES_AI_API_KEY`。

## 工具

### generate_video

| 参数 | 类型 | 默认 | 适用 |
|------|------|------|------|
| `prompt` | string | - | 全部（必填） |
| `model` | string | 配置值 | 全部 |
| `duration` | integer | 8 | 全部（秒） |
| `width` / `height` | integer | 1920 / 1080 | 仅 V2.0 |
| `frameRate` | integer | 24 | 仅 V2.0 |
| `size` | string | 720P | 仅 2.5 |
| `aspectRatio` | string | 16:9 | 仅 2.5 |
| `seed` / `negativePrompt` | - | - | 全部 |

### get_video_task

| 参数 | 类型 | 必填 |
|------|------|------|
| `jobId` | string | ✅ |

**幂等**：任务运行中返回 `processing`，完成后返回 `completed` + `videoUrl` + 本地 `attachment`。

## 异步工作流

```
1. generate_video { prompt: "..." }   → { taskId, jobId: "agnes-video-1", status: "queued" }
2. （等待，任务完成时 DSH 会通知）
3. get_video_task { jobId: "agnes-video-1" } → { status: "completed", videoUrl, attachment }
```

`queued` 之后**不要**重复发起同一次生成。需要旧行为时设 `awaitCompletion: true`。

## 注意

- 请求 `1920x1080` 会被服务端吸附为 **`1920x1088`**，返回值里的 `sizeAdjustment` 会说明原因。
- 免费额度有速率限制：短时间连续创建任务会 `429 rate_limit_exceeded`，等窗口重置即可，**不应立即重试**。
- `agnes-video-2.5-flash` 的 `size` 仅支持 `720P`。
- 后台任务依赖 base bundle 的 `dsh-jobs-local`；缺失时会退化为只报 `taskId`。

## 开发

```powershell
pnpm install
pnpm build
npx tsc -p tsconfig.json --noEmit
```

协议实现位于上层的 [`_core/`](../_core)，构建时内联进 `lib/`。

完整说明见 [上级 README](../README.md)；优化记录见 [OPTIMIZATION.md](../OPTIMIZATION.md)。

MIT
