# dsh-tool-agnes

Agnes AI 媒体生成插件集合，为 DeepSeek Harness (DSH) 提供图像和视频生成能力。

## 插件列表

| 插件 | 包名 | 功能 | 模型 |
|------|------|------|------|
| [dsh-tool-agnes-image](./dsh-tool-agnes-image) | `@dsh-plugins/agnes-image` | 文生图 | `agnes-image-2.1-flash` |
| [dsh-tool-agnes-video](./dsh-tool-agnes-video) | `@dsh-plugins/agnes-video` | 文生视频 | `agnes-video-v2.0` |
| [dsh-tool-agnes-img2vid](./dsh-tool-agnes-img2vid) | `@dsh-plugins/agnes-img2vid` | 图生视频 | Agnes AI |

## 快速开始

### 1. 安装依赖

```bash
cd dsh-tool-agnes-image
npm install
```

### 2. 配置 API Key

在 `$DSH_HOME/.credentials.yaml` 中添加：

```yaml
AGNES_API_KEY: your-api-key-here
```

或通过环境变量设置：

```powershell
$env:AGNES_API_KEY = "your-api-key-here"
```

### 3. 添加到 DSH Preset

在 `agent.cordis.yml` 中注册插件：

```yaml
# 图像生成
- id: tool-agnes-image
  name: '@dsh-plugins/agnes-image'

# 视频生成
- id: tool-agnes-video
  name: '@dsh-plugins/agnes-video'

# 图生视频
- id: tool-agnes-img2vid
  name: '@dsh-plugins/agnes-img2vid'
```

## 使用方式

### 图像生成

直接告诉 AI 你想要生成的图像：

```
帮我生成一张图片：沙漠日落，金色沙丘，电影级写实风格
```

```
创建一个科技感十足的 UI 设计原型，深色主题，霓虹灯光效果
```

### 视频生成

```
帮我生成一个视频：猫咪在阳光明媚的草地上奔跑
```

```
创建一个沙漠日落的视频，时长 8 秒，1080p 分辨率
```

### 图生视频

```
把这张图片变成视频：[图片] 让画面中的人物动起来
```

## API 参考

### 图像生成参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 图像描述提示词（英文效果更佳） |
| `size` | string | ❌ | `1K` | 分辨率档位：`1K` / `2K` / `3K` / `4K` |
| `ratio` | string | ❌ | `1:1` | 宽高比：`1:1` \| `16:9` \| `9:16` \| `4:3` \| `3:4` \| `3:2` \| `2:3` |
| `format` | string | ❌ | `url` | 返回格式：`url` 或 `b64_json` |

**推荐尺寸组合：**

| 场景 | Size | Ratio | 输出分辨率 |
|------|------|-------|-----------|
| 横版视频封面 | 2K | 16:9 | 2624×1472 |
| 竖版短视频 | 2K | 9:16 | 1472×2624 |
| 正方形 / 社交媒体 | 2K | 1:1 | 2048×2048 |
| 超宽屏 | 2K | 21:9 | 2688×1280 |

### 视频生成参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | ✅ | - | 视频描述提示词 |
| `width` | integer | ❌ | 1920 | 视频宽度（像素） |
| `height` | integer | ❌ | 1080 | 视频高度（像素） |
| `durationSeconds` | double | ❌ | 8 | 时长（秒） |
| `frameRate` | integer | ❌ | 24 | 帧率 |

> **注意**：帧数自动计算为 `8n+1` 规则（最大 441 帧 ≈ 18.4 秒 @ 24fps）

## 提示词建议

### 图像生成

- 使用详细、具体的英文描述效果更佳
- 添加风格关键词：`cinematic`, `photorealistic`, `4K`, `film grade`
- 指定光影效果：`golden hour`, `warm lighting`, `dramatic shadows`

### 视频生成

- 包含镜头运动描述：`slow zoom in`, `panning shot`, `static shot`
- 指定光线和氛围：`cinematic lighting`, `soft ambient light`
- 描述主体动作和场景变化

## 项目结构

```
dsh-tool-agnes/
├── dsh-tool-agnes-image/     # 文生图插件
│   ├── src/
│   │   ├── index.ts          # 插件入口
│   │   ├── credential.ts     # API Key 读取
│   │   ├── export.ts         # 导出定义
│   │   └── types.ts          # 类型定义
│   ├── cordis.yml            # Cordis 配置
│   ├── package.json
│   └── README.md
├── dsh-tool-agnes-video/     # 文生视频插件
└── dsh-tool-agnes-img2vid/   # 图生视频插件
```

## 构建

```bash
# 单个插件
cd dsh-tool-agnes-image
npm run build

# 开发模式（监听文件变化）
npm run dev
```

## 相关链接

- [DeepSeek Harness 文档](https://github.com/deepseek-ai/deepseek-harness)
- [Agnes AI API 文档](https://apihub.agnes-ai.com/)
- [私人仓库 (dsh-projects)](https://github.com/Dingpenghui-good/dsh-projects)

## License

MIT
