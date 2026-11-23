# 设计：无边框模式按住阅读区中央拖动移动窗口

日期：2026-11-22

## 问题

无边框模式（F9）隐藏系统标题栏后窗口无法移动（README 现状：「期间不可拖动/调整大小」）。目标：无边框期间在阅读区（窗口中央）按住拖动即可移动窗口。

## 核心取舍（已与用户确认）

阅读区是 `user-select: text`（双击取词→局部编辑、拖选文字供查找默认词）。采用**移动超阈值才算拖窗**方案：

- 按下后位移 ≥5px 才调用系统拖窗；单击、双击取词完全不受影响
- 代价：无边框期间「按住拖选文字」变成拖窗（沉浸阅读可接受）；退出无边框一切恢复
- 备选否决项：按 Alt 拖（需键盘配合）、按下立即拖（双击取词失效）

## 实现

1. **`src/fullscreen.ts`**（无边框模块内新增，initFullscreen 挂载）：
   - `#reader-content` 上监听 mousedown：仅无边框（`isBorderless()`）、非浏览器演示、左键时记起点并武装
   - mousemove 位移 ≥ `DRAG_THRESHOLD`(5px)：先 `getSelection().removeAllRanges()` 清半截选区，再 `getCurrentWindow().startDragging()`（try/catch），解除武装
   - window mouseup 兜底解除武装；拖窗开始后 OS 接管指针，残留武装无副作用（下次 mousedown 先复位）
   - 插件视图/面板/四边热区均为上层元素，不落在 reader-content 上，天然不误拖
2. **`src-tauri/capabilities/default.json`**：加 `core:window:allow-start-dragging`（缺失会静默失效，同置顶权限坑 de3bce0）

## 不改的东西

- 不加 `user-select: none`（会连累双击取词失效）；cursor 保持 text
- 普通窗口模式（有标题栏）不引入；`index.html`/`shortcut.ts` 无结构/快捷键改动

## 同步项

- README 无边框模式行补「按住中央拖动可移动窗口」
- `menubar.ts` showShortcuts 的 F9 描述、进入无边框 toast（app.ts）提及中央拖动

## 验证

- `npm run build`（tsc 类型检查 + vite）+ `cargo check`（build.rs 会校验 capabilities 权限标识）
- 浏览器演示回归：无边框切换、双击取词不受影响；真实拖窗为 OS 级行为，需用户桌面端手测

## 实现期修订记录（2026-11-23）

macOS 桌面手测发现拖动无效，两轮修复后定位到根因。调试方法：`RB_DEBUG_DRAG=1`
注入 JS 探针（结果写悬浮角标，窗口坐标用外部 CGWindowList 工具观测），三个
决定性实验——Rust 侧 `set_position` 正常（排除 tao/AppKit 层）、JS 侧
`cursorPosition` 正常、JS 侧 `setPosition` 被拒并回显权限名——直接定案。

1. **根因：capabilities 缺 `core:window:allow-set-position`**。自管拖窗调用
   `win.setPosition()` 被 IPC 权限层拒绝，错误又被 `.catch(() => {})` 吞掉，
   表现为窗口纹丝不动。这是本仓库第三次踩「窗口 API 权限静默拒绝」坑
   （前两次：置顶缺 allow-set-always-on-top、拖动缺 allow-start-dragging）。
   补权限 + 新增 `src-tauri/tests/capabilities.rs` 固定前端实际用到的窗口写
   权限清单（变异验证过会红），防第四次。
2. **方案微调：放弃 rAF 轮询 `cursorPosition()`，改事件驱动**。tao 0.37.1 的
   macOS `cursor_position()` 实现（platform_impl/macos/util/mod.rs）把
   `NSEvent mouseLocation`（点坐标，Y 自底向上）与
   `CGDisplay::pixels_high()`（像素）混算，返回值 X 是点、Y 是「像素高−点」，
   与 `outerPosition`/`setPosition` 的物理像素不可换算（探针实测 scale=2 下
   X 偏一半、Y 量纲错乱）。现改为：mousedown 时取一次窗口物理位与
   `scaleFactor()`，之后以 webview `mousemove` 的 clientX/Y 增量 × 缩放求
   setPosition 目标——拖窗时光标始终钉在窗口内抓取点，webview 事件不会断，
   也免掉每帧 IPC 轮询。
3. 前次提交 ec05c3c 的合成 mouseDown 方案（objc2-app-kit）整体移除。

## 实现期修订记录二（2026-11-23，真手测试后）

权限修复后真手仍拖不动，悬浮角标（记录 mousedown/mousemove 的 client/screen/
movement 坐标）暴露两个残留问题，修复后真手验证通过：

1. **监听面漏掉插件视图**：原挂 `#reader-content`，而自动恢复常落在视频等
   插件视图上（`#plugin-view-host` 是其兄弟节点、覆盖阅读区）——视频页面
   按下根本不进处理器。改挂 `#reader-container`（文本区与插件视图宿主同在
   其内），左右面板/各栏仍在外面不会误命中。
2. **跟随坐标必须用 screenX/Y，不能用 clientX/Y**：clientX 相对窗口原点，
   窗口一动误差信号即被自身位移抵消（目标位恒被拉回，表现为拖不动/半速
   抖动）。真手数据实证：拖动中 screen 每拍稳定 +7~8（与 movementX 一致），
   client 几乎不动——窗口确实跟着光标走。判阈仍用 client（按下后窗口未动
   前判超阈值，语义不变）。
3. 调试注意：vite HMR 对 tauri dev 页面并非每次都推送（本次重启前两轮修改
   均未送达页面，「改了没生效」的时间线被污染）。验证前端改动前先确认
   dev 日志出现 `hmr update`，必要时直接重启 `npm run tauri dev`。
