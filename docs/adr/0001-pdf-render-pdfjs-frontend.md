# PDF 渲染选前端 pdf.js，不走 Rust FFI 与系统查看器

---
status: accepted
---

PDF 阅读插件需要渲染引擎。三个候选里选了**前端 pdf.js**（npm `pdfjs-dist`，Canvas 渲染，打进外部插件的自包含单文件 ESM）。拒绝 Rust 侧 pdfium/mupdf FFI：会引入跨平台动态库分发，并直接违反 iOS 编译门禁约定（`smb.rs` 特意纯 Rust 就是为了保住这条门禁）；拒绝交给 WebView 内置查看器：Linux 的 WebKitGTK 没有内置 PDF 查看器，桌面主平台直接不可用。代价是接受插件包体 +2~3MB（pdf.js 核心+worker blob 内联、cmaps 仅简繁中文系列、standard_fonts 暂跳过），以及首版 CJK 正确性依赖 cmap 取舍——出现豆腐块再补齐。

## Consequences

- 源自 pdf.js 的体积与 worker 加载方式（blob 自启动）是插件构建脚本的长期约束，换渲染引擎约等于重写插件。
- 系统查看器路线永久关闭：任何「为什么不用 iframe 嵌系统查看器」的问题以本 ADR 为准。
