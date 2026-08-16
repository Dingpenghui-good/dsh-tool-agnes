# Agnes AI 视频生成插件

这个插件为 DSH 添加了视频生成能力，使用 Agnes AI 的 `agnes-video-v2.0` 模型。

## 功能特性

- **generate_video** 工具：通过文本提示生成视频
- 异步任务处理，自动轮询完成状态
- 结果通过会话日志持久化

## 已安装配置

插件已添加到以下位置：

| 文件 | 用途 |
|------|------|
| `E:\dsh-workspace\dsh-tool-agnes-video\` | 插件源码 |
| `C:\Users\dph\.dsh\profiles\web\cordis.yml` | DSH Web profile 配置 |

## 使用方法

### 1. 重启 DSH

在终端中停止当前进程（`Ctrl+C`），然后重新启动：

```bash
cd E:\deepseek-harness
pnpm dsh web
```

### 2. 使用视频生成工具

在 DSH 对话中，你可以直接使用 `generate_video` 工具：

```
请帮我生成一个视频，内容是一只猫在阳光下打盹
```

工具会自动：
1. 调用 Agnes AI API 创建视频生成任务
2. 轮询任务状态（每 5 秒检查一次）
3. 等待视频生成完成（最多 5 分钟）
4. 返回视频 URL

### 3. 工具参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 视频描述文本 |
| `duration` | integer | ❌ | 4 | 视频时长（秒） |
| `width` | integer | ❌ | 720 | 视频宽度（像素） |
| `height` | integer | ❌ | 1280 | 视频高度（像素） |
| `fps` | integer | ❌ | 8 | 帧率 |

### 4. 示例

```
生成一个 10 秒的沙漠日落视频，宽度 1920，高度 1080
```

```
帮我创建一个猫咪在草地上奔跑的视频，时长 8 秒
```

## 技术细节

### API 端点

- **Base URL**: `https://apihub.agnes-ai.com/v1`
- **模型**: `agnes-video-v2.0`
- **认证**: Bearer Token（从 `AGNES_API_KEY` 环境变量读取）

### 任务流程

```
用户请求 → POST /video/generations → 获取 taskId
    ↓
轮询 GET /video/generations/{taskId} (每 5 秒)
    ↓
完成/失败 → 返回视频 URL 或错误信息
```

### 超时处理

- 默认超时：5 分钟（300 秒）
- 轮询间隔：5 秒
- 最大轮询次数：60 次

## 故障排除

### 问题：视频生成失败

检查以下几点：
1. API Key 是否正确设置
2. 网络连接是否正常
3. 提示内容是否符合安全政策

### 问题：超时

如果视频生成时间过长，可以：
1. 减少视频时长（`duration` 参数）
2. 降低分辨率（`width`/`height` 参数）
3. 增加超时时间（修改插件配置）

## 插件源码结构

```
E:\dsh-workspace\dsh-tool-agnes-video\
├── src/
│   ├── index.ts      # 主入口，定义 generate_video 工具
│   └── export.ts     # 导出类型
├── package.json      # 包配置
├── cordis.yml        # Cordis 插件配置
└── README.md         # 文档
```

## 扩展开发

如需修改插件，编辑 `src/index.ts` 后重启 DSH 即可生效（DSH 支持 HMR）。
