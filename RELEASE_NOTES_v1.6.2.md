# 发布说明 v1.6.2

**日期：** 2026-10-03

## 修复 / Fixes

- **`workspace:^` 协议误发**：1.6.1 的 `@dingpenghui/agnes`（profile bundle）把组件包依赖原样写成了 `workspace:^`（pnpm monorepo 专用协议），发布到 npm 后消费端解析失败。现在改为显式 `^1.6.1` 版本语义。
  - 组件包（`agnes-image` / `agnes-video` / `agnes-img2vid`）的 1.6.1 发布本身正确（无 workspace 协议），无需重发；本版本仅修正 profile bundle。

## 不变 / Unchanged

- 1.6.1 的全部修复（宿主模块 `dsh-*` 从 `dependencies` 移到 `peerDependencies`，消除插件树第二份 `dsh-tools` 实例）保持不变。
- 四个工具的调用逻辑、模型配置、credential 解析链全部不变。

## 升级指引 / Upgrade

- 从 1.6.1 升到 1.6.2 无 breaking change，直接 `pnpm update @dingpenghui/agnes` 即可。
