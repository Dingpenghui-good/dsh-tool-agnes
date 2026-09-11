# @dingpenghui/agnes-img2vid

DSH 插件：Agnes AI **图生视频**，注册 `generate_img2vid` 工具。

与 [`@dingpenghui/agnes-video`](../dsh-tool-agnes-video) 共用同一套请求与轮询实现（`_core/`），区别只在请求体携带 `image` 字段。已在线上验证：带 `image` 创建的 V2.0 任务，轮询报文显示 `mode=ti2vid`、`image=set`。

## 能力

- 以一张图片作为起始帧生成视频，可选 `prompt` 描述期望的运动
- **图片不必公网可达**：实测 `POST /v1/videos` 的 `image` 字段接受 `data:` URL，因此本地图片会被插件自动内联
- 支持 V2.0 与 2.5 两代请求形状
- 与 video 插件一致：**默认非阻塞**，后台任务渲染，完成后落盘

## 图片来源

`image` 参数可以**省略**——省略（或传 `latest`/`recent`/`last`）时，插件自动使用**当前会话最近一张图**，也就是用户刚粘贴/上传的那张。模型看不到粘贴图片的 `attachmentId`，所以由插件自己维护这个索引（订阅 `session/event`）。

也可以显式指定：

| 来源 | 写法 | 处理 |
|------|------|------|
| 会话最近图片 | 省略 `image`，或 `latest` | 按会话取最近一张，经附件服务读取后内联 |
| 公网 URL | `https://example.com/a.jpg` | 原样透传，provider 自己取 |
| DSH 附件 | `attachment:26d7ca71e000…` | 从附件存储读字节 → data URL |
| 本地文件 | `E:\pics\a.jpg`、`@a.jpg` | 读文件 → 魔数探测 → data URL |
| 内联数据 | `data:image/jpeg;base64,…` | 原样透传 |

结果里的 `image` 字段会回填实际使用的引用（会话图会变成 `attachment:<id>`），模型由此可以再次引用同一张图。

`generate_image` 的摘要里也会输出可复制的 `attachment:<id>`，所以「先生成图、再做成视频」同样不需要任何外部托管。

```
1. generate_image → "- attachment: attachment:26d7ca71e000…"
2. generate_img2vid { image: "attachment:26d7ca71e000…", prompt: "slow push in" }
```

解析发生在创建 provider 任务**之前**——图片读不到时立即失败，不会留下一个已计费的空任务。

## 配置

```yaml
- id: tool-agnes-img2vid
  name: '@dingpenghui/agnes-img2vid'
  config:
    model: agnes-video-2.5-flash
    pollIntervalMs: 5000
    timeoutMs: 900000
    maxConsecutiveFailures: 4
    ferryContext: true
    awaitCompletion: false
    persistVideo: true
    maxInlineImageBytes: 8388608   # 本地图片内联上限，默认 8 MB
```

凭据：`AGNES_AI_API_KEY`（回退 `AGNES_API_KEY`）。

## 工具参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image` | string | ❌ | 图片来源；**省略即用会话最近一张图** |
| `prompt` | string | ❌ | 运动描述 |
| 其余 | - | ❌ | 同 `generate_video` |

返回的 `imageResolution` 说明该图片是 `remote-url`（provider 自取）还是 `inline`（内联进请求）。

## 结果读取

本插件只创建任务，**不注册查询工具**（避免与 video 插件的 `get_video_task` 重名）。收集结果的方式：

1. 装了 `@dingpenghui/agnes-video` → 用 `get_video_task { jobId }`；
2. 没装 → 用 DSH 内置的 `job_output` 工具读同一个 job。

## 已知限制

- **会话图片窗口只覆盖本次进程内到达的图片**：DSH 重启前粘贴的图片不再被索引；重启后新粘贴的正常。
- **内联体积上限 8 MB**：base64 膨胀约 33%，超限时请先压缩或改用公网 URL。

## 开发

```powershell
pnpm install
pnpm build
npx tsc -p tsconfig.json --noEmit
```

协议与来源解析位于上层的 [`_core/`](../_core)，构建时内联进 `lib/`。

完整说明见 [上级 README](../README.md)；探测依据见 [`_verify/README.md`](../_verify/README.md)。

MIT
