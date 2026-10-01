// Agnes AI 媒体生成 bundle 壳。
//
// 对齐官方 dsh-base / dsh-experimental-*-profile 模式：bundle 壳本身不导出
// 任何运行时代码，它的全部作用是通过 package.json 的 `dsh.bundle.patch`
// 指向 `cordis.patch.yml`，把 3 个组件包（image / video / img2vid）的
// 行一次性 insert 进 profile。
//
// 因此这里只是空壳，让 loader 加载 bundle 时不因缺入口而报错。
export {};
