# 发布说明 v1.6.1

**日期：** 2026-10-03

## 修复 / Fixes

- **依赖模型重构**：三个组件包（`agnes-image` / `agnes-video` / `agnes-img2vid`）把宿主模块 `@deepseek-ai/dsh-agent`、`dsh-attachment`、`dsh-credentials`、`dsh-jobs`、`dsh-llm`、`dsh-tools`、`schemastery` 从运行时 `dependencies` 移到 `peerDependencies`（标 `optional: true`），仅保留 `@deepseek-ai/cordis` 作为必选 peer。
  - 根因：这些包是 DSH 宿主扩展，运行时在宿主进程内执行。宿主已经把 `dsh-*` 加载进同一进程作为宿主模块。组件包若再以 `dependencies` 携带同版本包，pnpm 会在插件树里**再实例化一份**，`dsh-tools` 内部的 `TOOL_RUNTIME_SCHEDULER` Symbol 跨实例查不到，宿主调度器取到 `undefined`，触发 `Cannot read properties of undefined (reading 'prepare')` 整轮崩溃（详见 10-03 崩溃调查报告）。
  - 影响：插件自身代码行为不变，只改变了"谁提供这些包"——现在统一由 DSH 宿主提供，单实例，Symbol 身份不分裂。
- **`@dingpenghui/agnes`（profile bundle）**：版本 1.6.0 → 1.6.1，跟随组件包修复（其 `dependencies` 仍写 `workspace:^`，发布后保持 `^1.6.1` 语义，指向修复后的组件包）。

## 不变 / Unchanged

- 四个工具（`generate_image` / `generate_video` / `get_video_task` / `generate_img2vid`）的调用逻辑、模型配置、credential 解析链全部不变。
- `smoke-test` 不变。

## 升级指引 / Upgrade

- 从 1.6.0 升到 1.6.1 无 breaking change，直接 `pnpm update @dingpenghui/agnes` 即可。
- 插件安装后宿主行为不变，但不再在插件树里携带 `dsh-*` 副本。
