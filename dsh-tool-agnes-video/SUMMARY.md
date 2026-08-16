# Agnes AI 视频生成插件 - 完成总结

## ✅ 已完成的工作

### 1. 插件源码
- **位置**: `E:\dsh-workspace\dsh-tool-agnes-video\src\index.ts`
- **功能**: 实现 `generate_video` 工具，调用 Agnes AI 视频模型

### 2. DSH 配置
- **位置**: `C:\Users\dph\.dsh\profiles\web\cordis.yml`
- **内容**: 加载视频生成插件到 DSH Web profile

### 3. LLM 配置更新
- **位置**: `C:\Users\dph\.dsh\settings.yaml`
- **更新**: 
  - 为 `agnes-image-2.1-flash` 添加 `[text, image]` 输入模态（支持图片读取）
  - 为 `agnes-video-v2.0` 添加描述字段

### 4. 文档
- `README.md` - 插件说明和使用指南
- `USAGE.md` - 详细使用说明
- `test-video.ps1` - API 测试脚本

---

## 📁 文件结构

```
E:\dsh-workspace\dsh-tool-agnes-video\
├── src/
│   └── index.ts          # 插件主代码
├── package.json          # NPM 包配置
├── cordis.yml            # Cordis 插件配置
├── README.md             # 中文文档
├── USAGE.md              # 使用说明
└── test-video.ps1        # PowerShell 测试脚本

C:\Users\dph\.dsh\
├── profiles\web\
│   ├── cordis.yml        # DSH Web profile (已更新)
│   └── cordis.patch.yml  # Profile 补丁 (已更新)
└── settings.yaml         # LLM 配置 (已更新)
```

---

## 🚀 使用方法

### 重启 DSH
```bash
cd E:\deepseek-harness
pnpm dsh web
```

### 在对话中使用
直接请求生成视频：
```
帮我生成一个视频：一只猫咪在阳光下打盹
```

或使用参数：
```
生成一个 10 秒的沙漠日落视频，宽度 1920，高度 1080
```

---

## ⚠️ 注意事项

### API 可用性
当前 Agnes AI 的视频生成 API 端点可能需要额外授权。如果遇到认证错误：

1. 检查 API Key 是否有视频生成权限
2. 联系 Agnes AI 确认 API 状态
3. 参考 [Agnes AI 官方文档](https://agnes-ai.com/)

### 模型选择
- **文本任务**: 使用 `agnes-2.5-flash` 或 `agnes-2.5-pro`
- **图片任务**: 切换到 `agnes-image-2.1-flash`
- **视频任务**: 使用 `agnes-video-v2.0`

---

## 🔧 扩展开发

如需修改插件：
1. 编辑 `E:\dsh-workspace\dsh-tool-agnes-video\src\index.ts`
2. 重启 DSH 即可生效（支持 HMR）

---

## 📝 下一步建议

1. **测试 API**: 运行 `test-video.ps1` 验证 API 连接
2. **调整配置**: 根据实际 API 行为修改超时和轮询设置
3. **添加错误处理**: 增强对各类错误的优雅处理
