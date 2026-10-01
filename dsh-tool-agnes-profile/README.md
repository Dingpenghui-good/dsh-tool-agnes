# @dingpenghui/agnes

Agnes AI 媒体生成 **bundle**（一个开关挂载三个组件），对齐 DSH 官方 `dsh-base` /
`dsh-experimental-*-profile` 的"一个插件 + N 组件"模式。

这个包本身不导出运行时代码（`lib/index.js` 是空壳），它的全部作用是
通过 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，把下面 3 个
组件包一次性 `insert` 进 profile，使得在 UI 里"一个开关"即可同时启用
文生图、文生视频 + 任务查询、图生视频三套工具。

| 组件 | 包名 | 工具 | 行 id |
|------|------|------|-------|
| 文生图 | `@dingpenghui/agnes-image` | `generate_image` | `tool-agnes-image` |
| 文生视频 | `@dingpenghui/agnes-video` | `generate_video`、`get_video_task` | `tool-agnes-video` |
| 图生视频 | `@dingpenghui/agnes-img2vid` | `generate_img2vid` | `tool-agnes-img2vid` |

三个组件各自是独立包，可单独安装、单独关闭；走本 bundle 则整体开关。

---

## 接入 DSH

在 profile 的 `package.json` 里加一条依赖即可：

```json
{
  "dependencies": {
    "@dingpenghui/agnes": "link:E:/dsh-workspace/dsh-tool-agnes/dsh-tool-agnes-profile"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@dingpenghui/agnes"
      ]
    }
  }
}
```

安装后重启 DSH。若要整体开关，在 UI 的"插件列表"里勾选 / 取消勾选
`@dingpenghui/agnes`；若要单独关掉某个组件，可在 profile 的 `cordis.patch.yml`
里追加一行：

```yaml
- id: tool-agnes-img2vid
  name: '@dingpenghui/agnes-img2vid'
  disabled: true
```

每个组件的默认模型 / 轮询参数都可在自己的 `cordis.patch.yml` 行覆写
（patch 替换整行 `config`，所以要重述全部保留的键）。

---

## License

MIT
