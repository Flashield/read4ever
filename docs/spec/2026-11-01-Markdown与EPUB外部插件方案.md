# Read4Ever Markdown 与 EPUB 外部插件方案

> 日期：2026-11-01　|　状态：已评审
> 决策：新增两个**外部插件**（`.rbplugin` 包）——`markdown-viewer`（Markdown 查看）与 `epub-viewer`（EPUB 查看），源码随仓库放 `plugins-dev/`，esbuild 打包自包含单文件 ESM；**Rust 侧零改动**，全部能力经既有 `PluginOpenContext` 获取。EPUB 双渲染模式：跟随阅读主题（默认）+ 书籍自带样式（Shadow DOM）可切换；含目录导航与按书记忆进度。

## 1. 需求与范围

- **markdown-viewer**：接管 `.md / .markdown / .mdown`，渲染为富文本阅读视图，跟随阅读主题（颜色/字体/字号/行距实时同步）；大纲面板（h1–h6 点击跳转）；同目录/同 zip 上一份/下一份接续；渲染/源码切换。
- **epub-viewer**：接管 `.epub`，解析 OPF+spine 逐章渲染；侧边目录（EPUB3 nav / EPUB2 NCX）跳章；上一章/下一章（Ctrl+PgUp/PgDn 与宿主按钮自动分发）；按书路径记忆阅读位置自动续读；「跟随主题 / 书籍样式」双模式可切换。
- 两插件均：多实例（每标签页独立）、状态栏上报、Esc 关闭、净化内容（剥 script/事件属性）。
- 非目标（YAGNI）：EPUB 整本连续滚动渲染、EPUB 内字体/排版引擎级还原、markdown 导出、双页/页模式适配、查找与关键词检索接入、EPUB3 固定版式（fixed-layout）精确排版、DRM。

## 2. 选型记录

**渲染库**：

| 方案 | 结论 |
|---|---|
| 打包成熟库（选定） | markdown 用 `marked`（GFM，~35KB）；zip 解压用 `fflate` 的 `inflateSync`（纯 JS，~10KB）。esbuild 打进各自 main.js，正确性靠成熟库 |
| 全手写 | markdown 边缘语法与 zip 中央目录各是几百行的坑，收益低，排除 |

- epub 的 XML/XHTML 解析用原生 `DOMParser`；zip **中央目录扫描手写**（~60 行，`zipfile.rs` 的 JS 翻版），条目**按需解压**（stored 切片 / deflate 走 inflateSync），不整包解压。
- 净化不引 DOMPurify：DOM 遍历剥 `script/iframe/object/embed`、`on*` 属性、`javascript:` 链接，~30 行。
- 编码探测不引库：BOM → UTF-8 严格解码 → GBK 回退（`TextDecoder` 原生支持）。

**EPUB 渲染**（用户选定「两者都要，可切换」）：

| 方案 | 结论 |
|---|---|
| 内联宿主 DOM + 跟随主题（选定，默认模式） | 与 txt 阅读体验一致，主题字体/配色/行距天然继承 CSS 变量与计算样式 |
| Shadow DOM + 书内 CSS（选定，切换模式） | 还原书籍排版且不污染宿主样式；同一份清洗管线，只换挂载层与样式注入 |
| iframe srcdoc | blob URL 与滚动/键盘跨边界麻烦，Shadow DOM 等价且简单，排除 |

**章节为单位渲染**（选定）：整本一次渲染对长篇小说（数百章、10MB+ HTML）太重；章内滚动 + 上一章/下一章 + TOC 跳章。预取下一章字节（不渲染）保证接续流畅。

**源码位置**：`read4ever/plugins-dev/<id>/`（仓库内版本化）；构建产物 gitignore。依赖（`marked`/`fflate`）加 read4ever 根 `package.json` devDependencies，`npm run build:plugins` 一条命令出包。

## 3. 目录结构与构建

```
read4ever/plugins-dev/
  _shared/
    theme.ts     # 主题跟随：读 --reader-* CSS 变量 + #reader-content 计算样式；
                 #   MutationObserver 监听 html/style 与 reader-content 变化回调
    decode.ts    # 编码探测：BOM → UTF-8 严格 → GBK
    sanitize.ts  # 轻量净化：剥 script/iframe/object/embed、on*、javascript: 链接
  markdown-viewer/
    manifest.json  src/main.ts   dist/（gitignore）
  epub-viewer/
    manifest.json  src/main.ts   dist/（gitignore）
```

- **manifest**：`api: 1`；id 与入口导出 id 一致；`markdown-viewer` / `epub-viewer`；版本 `1.0.0`。
- **类型**：插件源码 `import type { Read4EverPlugin } from "../../../src/plugins/types"`——esbuild 擦除 type 导入，零打包污染，免复制声明文件。
- **打包**：`npx esbuild src/main.ts --bundle --format=esm --outfile=dist/main.js --target=es2022`（vite 已带 esbuild，无需新增依赖）；Node 脚本用 `fflate.zipSync` 把 `manifest.json + main.js`（stored 即可，包小）打成 `.rbplugin`——零系统 zip 依赖，跨平台。
- **类型检查**：根 tsconfig 只覆盖 `src/`，插件源码单独以 `tsc --noEmit -p plugins-dev`（独立 tsconfig，include 插件与 `_shared`，type 导入指向 `src/plugins/types`）纳入 `build:plugins` 前置步骤。
- **安装**：桌面端插件管理 → 安装 `.rbplugin`；更新=重装同 id（宿主既有覆盖安装）。
- `_shared/` 代码被两插件各打包一份（外部插件无法共享运行时代码）；量小（合计 <200 行），接受。

## 4. markdown-viewer 设计

- `extensions: [".md", ".markdown", ".mdown"]`；`createView()` 多实例；无 `togglePlay/isPlaying`（无播放语义）。
- **渲染管线**：`ctx.bytes` → 编码探测 → `marked.parse` → 净化 → 注入 `ctx.host`。切换「源码」模式时 `<pre>` 纯文本直出（textContent，天然安全）。
- **样式**：scoped `<style>`（类前缀 `.rbmd-`）挂 host 内随视图销毁回收；颜色用 `var(--reader-bg/--reader-text/--ui-*/--accent)`，字体/字号/行距从 `#reader-content` 计算样式取。`_shared/theme.ts` 的 MutationObserver 在主题/字体变更时回调重套——**换主题实时跟随**。标题/代码块/引用/表格/图片间距按阅读尺度设计（标题不超过正文字号 1.6 倍等）。
- **大纲面板**：视图内按钮开关（同图片查看顶栏形态），列 h1–h6 层级缩进，点击 `scrollIntoView`；滚动时 IntersectionObserver 高亮当前所在标题。
- **上一份/下一份**：`navFile(±1)` 沿 `ctx.siblings` 用 `ctx.loadBytes` 原地换内容（写 `ctx.path` 让宿主 `activeFilePath()` 跟随）；跨容器接续语义同图片查看。zip 内 `.md` 条目（`xxx.zip::a.md`）天然走通（registry 按 `::` 拆分后按条目扩展名路由）。
- **插件菜单**（menu）：渲染/源码切换（`setSetting` 持久化，模块级偏好）。
- **状态栏**：`file`=文件名、`encoding`=`Markdown · UTF-8/GBK`、`position`=`第 x/y 份`（siblings 序）、`mode`=`模式: 渲染/源码`、`display`=`-`。
- 源码内图片：markdown 引用本地图片（相对路径）时经 `ctx.loadBytes` 读同目录文件转 blob URL（越界路径 catch 后显示占位）。

## 5. epub-viewer 设计

- `extensions: [".epub"]`；`createView()` 多实例。
- **解析管线**（打开时一次）：
  1. `ctx.bytes` → 中央目录扫描（EOCD/ZIP64）→ 条目表 `{名, 偏移, 压缩法, 大小}`；
  2. `META-INF/container.xml` → OPF 路径 → OPF 解析：manifest（id→href/media-type/properties）+ spine 顺序 + 元数据（dc:title，EPUB 版本）；
  3. TOC：EPUB3 取 `properties="nav"` 的 nav.xhtml（`nav[epub:type=toc] ol`），EPUB2 回退 spine `toc` 指向的 NCX（navPoint 递归）；均解析为 `{label, href, anchor}` 树并拍平供面板。
  4. 损坏容错：缺 container/OPF/TOC 时尽力降级（无 TOC 仅 spine 顺序翻章，toast 说明），解析彻底失败 `ctx.closeView()` + toast。
- **按需解压**：`entry(name)` → stored 切片 / `fflate.inflateSync`；结果 LRU 缓存（上限 32 条，图片字节大）；图片/svg 转 blob URL 按视图缓存，`deactivate` 时全部 revoke。
- **章节渲染**（两模式共用管线）：取 spine[i] 的 XHTML → `DOMParser("application/xhtml+xml")` → 净化 → 改写资源引用（img/image/svg use 的 src/xlink:href 按章内相对路径解到 zip 条目 → blob URL；a 链接解析同章锚点/跨章 href 并拦截点击）→ 产出 DocumentFragment。
  - **跟随主题**（默认）：fragment 注入 `.rbepub-content` 容器（同 markdown 的主题跟随样式，段落缩进/对齐按中文阅读优化）；
  - **书籍样式**：fragment 挂 Shadow DOM，OPF 中该章链接的 CSS 文件原文 `<style>` 进 shadow root；宿主不干预字体。
- **导航**：`navFile(±1)` = 上一章/下一章（spine 序，跳过非 linear）；TOC 侧边面板点击跳 `{spineIdx, anchor}`；章内锚点链接滚动定位；跨章链接切章后定位。面板 `tabindex=0` 聚焦接管 PgUp/PgDn/←→（监听挂面板内随销毁回收；`setActive(false)` 后台实例不响应）。
- **进度记忆**：`setSetting("pos:" + ctx.path, {spineIdx, ratio, ts})`，滚动防抖 2s 落盘；上限 200 条按 ts 淘汰。重开同书：渲染完成后跳到 `{spineIdx}` 并按 ratio 恢复滚动，toast「已续读」。菜单项「清除本书进度」。
- **插件菜单**：渲染模式切换（持久化）；清除本书进度。
- **状态栏**：`file`=当前章名（章 title/文件名）、`position`=`第 x/y 章 · 42%`（章内滚动比）、`encoding`=`EPUB 2/3`、`mode`=`模式: 跟随主题/书籍样式`、`display`=`-`。

## 6. 浏览器演示与验证

- `mock_backend.ts`：演示书库增加中文 `.md` 样例与 `.epub` 演示书（JS 现构造 **stored** zip：container.xml + OPF + nav + 3 章 XHTML + 1 图，~80 行，无需压缩）；两插件经完整外部链路加载——dev 下 mock 从 `plugins-dev/*/dist/` fetch manifest+main.js（vite `/@fs/` 直供仓库文件），未构建则静默跳过（hex-viewer 演示保留）。
- **真机验证**：`npm run tauri dev` + 安装构建出的 `.rbplugin`；覆盖路径：本地 `.md`/`.epub`、zip 内嵌条目（`书.zip::a.md` / `书.zip::novel.epub`——epub 插件拿到的是条目字节，自解压不受影响）、上一份/下一份接续、主题切换实时跟随、进度续读、双模式切换。
- 构建验证：`npm run build`（tsc）与 `npm run build:plugins` 全绿；产物大小记录（预期 markdown ~50KB / epub ~60KB）。

## 7. 收尾同步

- README：功能表插件系统行提及两插件与 `plugins-dev/` 构建方式；目录结构补 `plugins-dev/`。
- `docs/spec/插件开发.md`：补两插件为参考实现（含主题跟随技巧一节）。
- AGENTS.md（工作区根，不版本控制）：无需改动；Rust 侧零改动，无 store/命令变更。

## 8. 风险与对策

- **Chromium/WKWebView 兼容**：`fflate` 纯 JS 无兼容面；Shadow DOM、DOMParser、blob URL 均为 WebView 基础能力（iOS 移植面同样覆盖）。
- **恶意/畸形 epub**：净化管线 + 按需解压限制单条目 ≤64MB（超限 toast 拒读该条目）；中央目录畸形时报错关闭，不崩溃。
- **书路径作进度键泄漏增长**：200 条 LRU 上限。
- **`::` 复合路径歧义**（文件名含 `::`）：与宿主 openPath 同一约定（拆最后一个 `.zip::`），沿用 `registry.splitTarget` 语义即可。
