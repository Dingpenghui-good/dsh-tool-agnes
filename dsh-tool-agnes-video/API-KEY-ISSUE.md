# Agnes AI 视频生成插件 - 配置说明

## ⚠️ API Key 权限问题

当前 API Key 似乎没有视频生成权限。错误信息：
```
无效的令牌 (request id: xxx)
```

## 解决方案

### 1. 检查 API Key 权限

登录 [Agnes AI 控制台](https://agnes-ai.com/) 确认：
- API Key 是否已激活
- 是否有视频生成权限（可能需要单独申请）
- 账户余额是否充足

### 2. 获取正确的 API Key

视频生成可能需要专用的 API Key。请联系 Agnes AI 支持或查看控制台获取。

### 3. 更新配置

获取新的 API Key 后，更新凭据文件：

```powershell
# 方法 1: 环境变量
$env:AGNES_API_KEY = "your-new-api-key"

# 方法 2: 凭据文件
# 编辑 C:\Users\dph\.dsh\.credentials.yaml
AGNES_API_KEY: your-new-api-key-here
```

---

## 当前配置状态

| 功能 | 状态 | 端点 |
|------|------|------|
| 文本生成 | ✅ 可用 | `/v1/chat/completions` |
| 图片读取 | ✅ 可用 | `/v1/images/generations` |
| 视频生成 | ⚠️ 需要权限 | `/v1/videos` |

---

## 插件代码已更新

插件已使用正确的 `/v1/videos` 端点。一旦获得视频生成权限，功能即可使用。

**修改的文件**:
- `E:\dsh-workspace\dsh-tool-agnes-video\src\index.ts` - 更新为 `/v1/videos` 端点
- `E:\dsh-workspace\dsh-tool-agnes-video\test-video.ps1` - 测试脚本
