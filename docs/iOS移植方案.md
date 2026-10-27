# ReadBook iOS 版移植方案

> 日期：2026-10-26　|　状态：已定稿，待实施
> 决策：**续用 Tauri 2** 框架做 iOS 版（`tauri ios init` 路径），Rust 核心 100% 复用，前端复用 + 移动端适配，首版完整功能对等。

## 1. 背景与前提

ReadBook 为 Tauri 2 桌面端中文电子书阅读器（READBOOK.HLP 复刻）。本方案规划 iOS 版本的技术路线与实施阶段。

已确认的约束：

- **有 Mac 可用**（Xcode 编译/签名在 Mac 完成；日常开发在 Linux，仓库经 SyncProjects 同步）
- **分发**：先个人 Apple ID 自签装自己 iPhone（7 天重签可接受），后期考虑 App Store
- **UI**：复用 vanilla TS 前端 + 移动端适配，不重写

为什么选 Tauri 而非 Capacitor / SwiftUI 重写：

- 核心资产全在 Rust（容错 ZIP 读取器 `zipfile.rs`、编码检测链 `encoding.rs`、硬换行重排 `reorder.rs`）——换 Capacitor 需全部重写；SwiftUI 则 UI 层双端永久双维护
- 项目已移动就绪：Tauri 2.12.5、`crate-type` 含 `staticlib/cdylib`、`#[cfg_attr(mobile, tauri::mobile_entry_point)]` 已就位
- 后端通信收敛在 `api.ts`，`mock_backend.ts` 已提供后端抽象，前端无框架包袱

## 2. 已验证的平台事实（含两个纠错）

- Tauri 2 iOS 官方稳定支持；需 macOS + 完整 Xcode + rustup targets（`aarch64-apple-ios`、`aarch64-apple-ios-sim`）
- `tauri-plugin-dialog` 在 iOS：
  - `open()` 文件选择**可用**，但 Swift 侧把所选文件拷到 `Library/Caches`（**可被系统清除**，必须尽快导入拷贝）
  - `directory:true` 目录选择**硬性不支持**（返回 `FolderPickerNotImplemented`）
  - `save()` **已实现**（DialogPlugin.swift:138，导出模式 picker；写回语义待真机 spike）
- iOS 编译阻断点：`tauri` 的 `tray-icon` feature 与 `trash` crate（需 target 门控）
- 前端目前无任何平台检测（`main.ts` 仅查 `__TAURI_INTERNALS__` 区分 mock 模式）

## 3. 核心设计决策

| # | 决策 | 要点 |
|---|---|---|
| D1 | 路径间接层放 Rust 不放 TS | 新模块 `src-tauri/src/pathmap.rs`：`to_stored/to_abs`。桌面恒等映射（零迁移零回归）；iOS 存相对 `Documents/` 的路径（容器路径每次启动变化，相对路径免疫）。前端继续把路径当**不透明令牌**，`types.ts`↔`store.rs` 结构不变（AGENTS.md 同步规则不受影响） |
| D2 | 导入即拷贝（不用 security-scoped bookmarks） | iOS 书库根 `<container>/Documents/ReadBook/`。多选文件落 `Inbox/`；保留目录结构走"文件"App 拖文件夹（`UIFileSharingEnabled` 免费获得）。`find_next/find_prev` 遍历导入副本的父目录，逻辑不变 |
| D3 | 布局用 CSS 媒体查询，行为用平台助手 | `@media ((hover:none) and (pointer:coarse)), (max-width:760px)` 决定布局——手机布局可在 Linux 浏览器（`npm run dev` + 设备模拟）完整调试；JS 只门控行为 |
| D4 | 全屏策略 | 桌面保留 `document.requestFullscreen()`；移动端 CSS 沉浸模式（`body.immersive`） |
| D5 | 移除死插件 | `tauri-plugin-fs`/`tauri-plugin-opener` JS 侧从未调用，删除以减依赖面与权限面 |
| D6 | 回收站 | 桌面 `trash::delete`；移动端移入 `<app_data_dir>/Trash/` |

## 4. 实施阶段

### Phase 1 — 窄切片：iOS 编译通过 + 模拟器跑通 + 打开一个文件

**Rust：**

1. `src-tauri/Cargo.toml`：`tray-icon` feature 与 `trash` 移到 `[target.'cfg(not(any(target_os="android", target_os="ios")))'.dependencies]`（官方推荐写法）；删除 `tauri-plugin-opener`、`tauri-plugin-fs`
2. `src-tauri/src/lib.rs`：托盘构建整体 `#[cfg(desktop)]` 包裹；`on_window_event` 的 CloseRequested→隐藏到托盘加桌面门控；移除 opener/fs 的 `.plugin()` 注册
3. `src-tauri/src/commands.rs`：`hide_to_tray`/`show_from_tray`/`exit_app` 体加 `cfg!(desktop)`（注册保持无条件，两端命令表一致）；`trash_path` 移动端临时 `fs::remove`（Phase 4 换正式方案）；**新增 `get_platform()` 命令**（platform/desktop/mobile/documentsDir，前端唯一平台事实来源）
4. `src-tauri/capabilities/default.json`：删 `opener:default`、`fs:default`

**前端：**

5. 新 `src/platform.ts`（~40 行）：`detectPlatform()`（UA 兜底 + invoke get_platform），设 `body.classList`；含 `stripFileScheme()`（iOS picker 返回 `file://` 前缀）
6. `src/api.ts`：picker 结果过 `stripFileScheme`
7. `src/app.ts`：`boot()` 首行 `await detectPlatform()`；移动端跳过 `initDragDrop()`（app.ts:1018）；`hideToTray`/`exitApp` 桌面门控
8. `src/shortcut.ts`：`T`/Ctrl+Q 桌面门控
9. `index.html` viewport 加 `viewport-fit=cover`；`src/styles.css` 菜单栏/工具栏/状态栏加 `env(safe-area-inset-*)`
10. `package.json` 加 `ios:dev`/`ios:build`/`ios:open` scripts

**Mac 一次性操作**：`rustup target add aarch64-apple-ios aarch64-apple-ios-sim` → `npm run tauri ios init` → 模拟器 `ios dev`。`.gitignore` 提交 `gen/apple` 但排除 `xcuserdata/`、`*.xcuserstate`、`build/`、`DerivedData/`

**验证**：Linux `cargo check --target aarch64-apple-ios-sim`（无需 Xcode 的最便宜门禁）+ `cargo test` + `npm run build` + 浏览器 mock + 桌面 `tauri dev` 回归；Mac 模拟器拖入样例 zip → 打开 → GB18030 正确解码。

**内嵌 4 个 30 分钟 spike**：(a) iOS `open()` 返回串确切格式；(b) `.rbplugin` 经 Caches 副本能否被 Rust 直读；(c) `save()` 选"我的 iPhone"目标是否可写；(d) 扩展名过滤器在 iOS UTType 下是否生效。

### Phase 2 — 文件模型重构：沙盒相对路径 + 导入管线

1. 新 `src-tauri/src/pathmap.rs`：`stored_from`/`abs_from`（base=None 恒等）+ `mobile_base()`（iOS/Android 取 `Documents/ReadBook`，桌面 None）+ 单测 `tests/pathmap.rs`
2. `commands.rs` 14 个路径命令机械接线（入参 `to_abs`、出参 `to_stored`）：open/read/save/edit/find/list/trash/move/rename/make_dir；`read_zip_entry` 的 `"zip::entry"` 组合串用存储路径构建 → 历史/书签跨容器路径变化可回放
3. 新增 `import_files(paths, dest) -> Vec<String>`：拷入 `Documents/ReadBook/<dest|Inbox>/`（沿用现有 `unique_child` 命名）；配套 `get_library_dir()`
4. 前端：移动端"打开文件" = pick → `importFiles` → `openPath`；`src/folder.ts` `pickFolder()` 移动端直接 `setRoot(getLibraryDir())`（侧栏 `list_dir` 全在沙盒内，目录树照常）；`src/plugins/loader.ts` 按 spike(b) 结果先导入再装；`app.ts` 加 `visibilitychange`→持久化（iOS 不保证 beforeunload）
5. `mock_backend.ts` 增量实现三个新命令；`AGENTS.md` 补"路径是不透明令牌、TS 不得拼路径"规则

**验证**：Linux `cargo test`；桌面会话 diff——`readbook.json` 中路径与改造前逐字节同形（恒等映射实证）；模拟器导入→杀进程重装→自动恢复；"上/下一个文件"遍历导入副本；`.rbplugin` 端到端安装。

### Phase 3 — 移动阅读 UX 适配（大头在 CSS）

1. `src/styles.css` 移动媒体查询块：隐藏 `#menu-bar`；工具栏精简；右面板/文件夹侧栏改全屏 overlay；输入框 ≥16px（防 iOS 聚焦缩放）；`overscroll-behavior: contain`
2. 新 `src/touch.ts`：左/右 1/3 点击翻页（`reader.pageUp/pageDown`），中央切换沉浸模式；横滑 ~60px 上/下一个文件；长按现有上下文菜单；选区非空或目标在面板内时忽略；仅 `platform.isTouch` 挂载
3. `app.ts` `toggleFullscreen()`（app.ts:819-827）：移动端切 `body.immersive`，桌面路径不动
4. `menubar.ts`：工具栏加 ☰ 按钮 → 现有 MENUS 底部 sheet 呈现（`dropdown.ts` 加 `position:"sheet"`）；桌面专属项按平台隐藏
5. `panels.ts`/`folder.ts`：触屏跳过面板拖拽缩放、面板外点击关闭；`reader.ts` 欢迎文案按平台；`themes.ts` 字体栈追加 `-apple-system` 兜底（SimSun→Songti SC 已覆盖 iOS）

**验证**：Linux 浏览器设备模拟为主调试场；桌面 `tauri dev` 默认尺寸像素级不变；模拟器（iPhone 15 Pro 刘凹屏）单手操作全链路 + 安全区正确。

### Phase 4 — 文件 App 集成、导出、回收站

1. `gen/apple/.../Info.plist`：`UIFileSharingEnabled=true`、`LSSupportsOpeningDocumentsInPlace=false`、`CFBundleDisplayName=ReadBook`、方向支持、`ITSAppUsesNonExemptEncryption=false`；（stretch）`CFBundleDocumentTypes` "用 ReadBook 打开"
2. `trash_path` 移动端正式实现 = 移入 Trash 目录；`uninstall_plugin` 移动端主路径 `fs::remove_dir_all`
3. 移动端"另存为"按 spike(c)：优先 dialog `save()`，兜底写 `Exports/` + "可在『文件』App 查看"提示
4. 图标：1024×1024 PNG → Mac `npm run tauri icon`；README/AGENTS.md 补移动文件模型与 Mac 工作流

**验证**：模拟器"文件"App 可见书库；AirDrop 投 txt 可见；另存为产物可达；删书入 Trash；桌面 `tauri build` 产物不变。

### Phase 5 — 真机、签名、生命周期硬化

1. Xcode（`ios dev --open`）签名 Team = 个人 Apple ID（bundle id 不变；7 天过期/3 app 上限/无 iCloud）
2. 真机 dev：`npm run tauri ios dev --host --force-ip-prompt`（vite 已接 `TAURI_DEV_HOST`），同意本地网络权限并重启一次
3. 生命周期：后台/杀进程/锁屏各 10 轮，滚动位置与阅读秒数存活
4. 性能 sanity：最大样例章节若 WKWebView 卡顿 → 记录为后续分块渲染任务

### Phase 6（可选，后期）— App Store 准备

付费开发者账号 → App Store Connect → `tauri ios build` IPA → Transporter/TestFlight；`csp` 保持 `null`（若收紧必须放行 wry 自定义协议 + `script-src 'self' blob:`——插件加载器 blob ESM）；截图与隐私清单（无追踪，不需要）。

## 5. Mac ↔ Linux 协作

| Linux（开发） | Mac（构建） |
|---|---|
| 全部代码编辑、`cargo check [--target aarch64-apple-ios-sim]`、`cargo test`、`npm run build`、浏览器 mock/移动布局调试 | `npm install`、rustup targets、一次性 `tauri ios init`、`ios dev`/`--open`、签名、`tauri icon`、`ios build` |

**同步工具必须排除**：`src-tauri/target/`、`node_modules/`、`gen/apple/**/xcuserdata/`、`*.xcuserstate`、`gen/apple/{build,DerivedData}/`（跨机同步平台二进制会互相污染）；`Cargo.lock`/`package-lock.json` 正常提交。

## 6. 风险与 spike 清单

- **S1** picker 返回的 Caches 副本 vs in-place URL 的 Rust 可读性 → 受限则用 `fileAccessMode:'copy'` 或同会话立即拷贝
- **S2** `save()` iOS 写回语义 → Phase 4 有兜底
- **S3** WKWebView 内 blob-URL 动态 `import()`（.rbplugin 加载器）→ 失败则 `data:` URL 或 eval shim，改动收敛在 `src/plugins/loader.ts`
- **S4** tray-icon/trash 是否真在 iOS 编译失败 → 无论结果，target 门控都是正确写法
- **S5** "用 ReadBook 打开"事件能否送达 webview → stretch，不强求
- 软风险：小屏键盘遮挡查找栏（visualViewport 兜底）、UTType 过滤器可能不生效、老设备大文本渲染、7 天重签节奏
- **S6 SMB 视频流式**（2026-10-27 新增，桌面端已实现）：模拟器连真实 NAS 播放/seek，验证 WKWebView 媒体元素经 WKURLSchemeHandler 发起的 Range 请求得到 206/Content-Range 正确响应（注意 AVPlayer 的探测区间与 seek 任务取消语义）；Android 侧验证 shouldInterceptRequest 是否携带 Range 头。降级预案：异常平台 streamUrlFor 返回 null 回退整读（受 1 GB 上限），大文件引导用户「缓存到本地」。桌面实现零新增依赖，本门禁命令不变

## 7. 不改动清单（桌面回归保护）

- `zipfile.rs` 容错读取器及其"禁 by_index/整读"规则；zip crate 保持 dev-only
- `store.rs` serde 形状/camelCase/`#[serde(default)]` 规则与 `types.ts` 镜像；**本方案零新增 store 字段**
- `openPath`/`"zip::entry"` 组合路径契约；`reader.ts` 引擎语义只加外部触摸触发
- 桌面对话框语义与拖拽导入；面板 margin CSS 变量机制与无过渡规则；`mock_backend.ts` 契约只增量扩展
- 每阶段收尾必查：桌面 `tauri dev` 默认尺寸视觉与行为不变

## 8. 端到端验证清单（最终）

1. Linux：`cargo check`/`cargo check --target aarch64-apple-ios-sim`/`cargo test`/`npm run build` 全绿；浏览器 mock 正常
2. 桌面回归：打开/书签/历史/托盘/快捷键/面板缩放与改造前一致
3. 模拟器：导入→阅读→恢复→插件安装→另存为→删除，全链路
4. 真机：完整读一章 GB18030 zip，后台返回位置保持，飞行模式可用
