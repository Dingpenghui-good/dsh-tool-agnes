# Agnes AI 视频生成插件

为 DeepSeek Harness 添加视频生成能力，使用 Agnes AI 的 `agnes-video-v2.0` 模型。

## 已安装位置

| 文件/目录 | 说明 |
|-----------|------|
| `E:\dsh-workspace\dsh-tool-agnes-video\` | 插件源码 |
| `C:\Users\dph\.dsh\profiles\web\cordis.yml` | DSH Web profile 配置 |
| `C:\Users\dph\.dsh\settings.yaml` | LLM 提供商配置 |

## 快速开始

### 1. 重启 DSH

```bash
cd E:\deepseek-harness
pnpm dsh web
```

### 2. 在对话中使用

直接告诉 AI 你想生成什么视频：

```
帮我生成一个视频：一只猫咪在阳光明媚的草地上奔跑
```

```
创建一个沙漠日落的视频，时长 8 秒，1080p 分辨率
```

### 3. 工具参数

| 参数 | 类型 | 必填 | 默认值 |
|------|------|------|--------|
| `prompt` | string | ✅ | - | 视频描述 |
| `duration` | integer | ❌ | 4 | 时长（秒） |
| `width` | integer | ❌ | 720 | 宽度（像素） |
| `height` | integer | ❌ | 1280 | 高度（像素） |
| `fps` | integer | ❌ | 8 | 帧率 |

## 技术说明

### API 端点

- **Base URL**: `https://apihub.agnes-ai.com/v1`
- **模型**: `agnes-video-v2.0`
- **认证**: Bearer Token（从 `AGNES_API_KEY` 读取）

### 工作流程

```
用户请求 → 创建任务 → 轮询状态 → 返回视频 URL
              ↓              ↓
         POST /video/   GET /video/{id}
         generations    generations/{id}
```

### 超时处理

- 默认超时：5 分钟
- 轮询间隔：5 秒
- 最大轮询次数：60 次

## 故障排除

### API Key 错误

```
Error: AGNES_API_KEY is not set
```

解决方法：
```powershell
$env:AGNES_API_KEY = "your-api-key"
```

或在 `C:\Users\dph\.dsh\.credentials.yaml` 中配置：
```yaml
AGNES_API_KEY: your-api-key-here
```

### 视频生成失败

当前 Agnes AI 的视频生成 API 端点可能尚未公开。如果遇到以下错误：

```
Video generation failed: 无效的令牌
```

这可能是：
1. API Key 未授权视频生成权限
2. 视频生成功能需要额外申请
3. API 端点尚未完全部署

建议联系 Agnes AI 支持确认视频生成 API 的可用性。

## 插件结构

```
dsh-tool-agnes-video/
├── src/
│   └── index.ts      # 主入口，defineTool + apply
├── package.json      # 包配置
├── cordis.yml        # Cordis 插件配置
├── README.md         # 文档
└── USAGE.md          # 使用说明
```

## 相关文档

- [DSH 插件开发指南](https://github.com/deepseek-ai/deepseek-harness)
- [Agnes AI API 文档](https://agnes-ai.com/)
