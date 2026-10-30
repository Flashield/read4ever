# 文件名自然排序 + SMB 远程写操作 方案

日期：2026-10-29。两项独立需求，一份方案，实施时分任务序列。

## 需求 1：文件名自然排序（可开关）

### 现状与问题

- 本地侧栏（`commands.rs list_dir`）与 SMB 侧栏（`smb.rs list_dir`）排序一致：目录优先 + 名字小写典序 → `file10` 排在 `file2` 前
- 兄弟导航（上一个/下一个）用另一套 `seqfile.rs::seq_cmp`（首个数字段序号 + n+1 兜底），多数字段文件名（「第01话 第2节」）与列表显示顺序可能不一致
- ZIP 条目列表（`zipfile.rs list_zip_files`、`smb.rs list_zip`）不排序（按包内顺序）
- 前端 image-viewer（`src/plugins/image-viewer.ts:165,171`）用 `localeCompare("zh")` 自行重排容器条目，又是一套
- 四处顺序互不一致 → 统一为「自然排序」一种，且提供设置开关关回现状

### 设计

**比较器**：新建 `src-tauri/src/natural.rs`，手写 `natural_cmp(a: &str, b: &str) -> Ordering`（~40 行，无新依赖）：

- 逐段比较：数字段按 u64 数值比（数值相等时段短者在前，即前导零少者靠前），非数字段按小写码点比
- JS 版对齐规则：`Intl.Collator` 结果为 0 时按段长度短者在前补位，保证与 Rust 版一致
- 数字段与非数字段相遇：数字段在前（与现有「目录优先后按名」无冲突，仅名字段内部规则）
- 配 `#[cfg(test)]` 单测：`file2 < file10`、`第2节 < 第10节`、`a2b < a10b`、前导零、混合段、大小写

**前端对应**：`src/natural.ts` 导出 `naturalCompare(a, b): number`（`Intl.Collator("zh", { numeric: true, sensitivity: "base" })`，与 Rust 版语义对齐）与 `isNaturalSort()`（读 app 设置）。

**开关**：`Settings.naturalSort: boolean`（默认 `true`；旧配置合并时 `?? true`），「查看」菜单加「文件名自然排序」勾选项（随 `双页模式` 等现有开关模式：checked() + action 翻转 + persist）。切换后刷新文件夹侧栏与 SMB 侧栏。**关 = 完全回到现状行为**（列表典序 + seq_cmp 导航）。

**应用点（开关为真时）**：

| 位置 | 现状 | 改为 |
|---|---|---|
| `commands.rs list_dir` | 小写典序 | `natural_cmp`（目录优先不变）；命令加 `natural: bool` 参数 |
| `smb.rs list_dir` | 小写典序 | 同上 |
| `seqfile.rs list_sibling_files` | `seq_cmp` | `natural_cmp`；`find_next`/`find_prev` 命令加 `natural: bool` 透传 |
| `smb.rs find_sibling` | `seq_cmp` | 同上（签名加参） |
| `zipfile.rs list_zip_files` | 包内顺序 | `natural_cmp`（`open_zip_file` 命令加参）；SMB 路径经 `smb.rs list_zip` 同步生效 |
| `image-viewer.ts` | `localeCompare` 自排 | 开：改用 `naturalCompare` 排；关：保留原 `localeCompare`（现状行为） |

`natural: bool` 一律由前端传 `state.store.settings.naturalSort`（单一事实源，避免 Rust 读存储的时序问题）；`api.ts` 的 `listDir/nextFile/prevFile/listZip` 及 SMB 对应封装加参。

**不变的部分**：`seq_cmp` 及 `parse_file_num` 保留（关闭开关时导航用）；`next_among` 的 n+1 兜底逻辑不动（它按排好序的名字表工作，比较器可插拔）。

## 需求 2：SMB 远程写操作（完整对齐本地）

### 现状与决定反转

`smb.rs` 头部 spike 决定「远程侧只读：不调用 delete/rename/write 类接口」。本需求正式反转。`smb2` 0.35 源码已核实具备全部所需接口（`SmbClient` 便捷方法）：`delete_file`、`delete_directory`（非空报 NotEmpty，不会误删）、`create_directory`、`rename`（同 tree 内跨目录=移动）。前端 `src/smb.ts` 已有按行菜单体系（`menuForDir`/`menuForFile` + ⋮ 按钮 + `rowByPath`/`refreshDir`/`dropDirCache`），扩展即可。

### 设计

**Rust 命令**（`smb.rs` 新增，均走 client 便捷方法 + `with_timeout` + `evict_session` 错误语义，`resolve()` 路径/共享名校验复用）：

- `smb_delete(path)`：stat 判类型；文件 → `delete_file`；目录 → **自实现递归删除**（`list_directory` → 逐条递归文件/子目录 → 自底向上 `delete_directory`），任一步失败即报错并说明已删到哪层（尽力而为，不回滚）
- `smb_rename(path, new_name)`：同目录重命名 = `rename(path, parent/new_name)`
- `smb_move(path, to_dir)`：同共享内移动 = `rename(path, to_dir/name)`；两侧 `resolve()` 后必须同 `cfg.id + share`，否则报「跨共享移动暂不支持」
- `smb_mkdir(parent, name)`：`create_directory`

`lib.rs` 注册四个命令；`api.ts` 加对应封装。

**前端 UI**（`src/smb.ts`，镜像本地侧栏交互，见 `folder.ts:329` 起的先例）：

- `menuForFile` 加：重命名（行内输入框，同 `folder.ts startRename` 模式）/ 移动到… / 删除
- `menuForDir` 加：重命名 / 移动到… / 删除 / 新建文件夹
- 删除走**两段式确认**（同 `folder.ts:360` 模式：菜单里再点一次「删除」才执行）；SMB 无回收站，确认文案明确「永久删除，不可恢复」
- 「移动到…」弹**SMB 目录选择弹窗**（新小组件）：列当前共享内目录（复用 `loadChildren` 过滤 `is_dir`），支持上级/进入，按钮「移动到这里」；本地用的是系统目录选择器（`api.pickDirectory`），SMB 用不了
- 操作成功后 `dropDirCache` + `refreshDir` 受影响目录；被删文件的本地缓存副本不主动清（孤儿文件由「清除缓存」统一回收，spec 级接受）

**文档同步**：`smb.rs` 头部注释反转只读决定并记录 2026-10-29；`README.md` 两处——23 行 SMB 表格行「只读浏览」措辞、44 行「远程侧只读…」条目改为支持删除/重命名/移动/新建文件夹（注明无回收站、永久删除）。

## 边界情况

- 自然排序关闭：四类列表与导航全部回到现行行为，互相对齐现状（即现状的不一致也原样保留）
- 递归删除中途断线：报错 + 已删层次说明；重新删除可续（剩余部分重删）
- 重命名/移动目标重名：crate 返回冲突错误 → 原样报给用户（对齐本地 rename_path 行为）
- 移动弹窗中当前目录含被移对象自身/其子目录：选定时报「不能移动到自身内部」
- `find_next/prev` 对 SMB 关闭开关时走原 `seq_cmp` 路径，行为与现状逐字节一致
- 大目录递归删除耗时：单操作 15s 超时按现有 `with_timeout` 粒度（每步 list/delete 各自计时），整体不设总闸，删除按钮执行期间置 busy 态

## 验证

- `cargo test`（natural.rs 单测）+ `cargo build` + `npx tsc --noEmit` + `npm run build` 全绿
- 浏览器（mock）：自然排序开关对演示书库列表生效、image-viewer 兄弟导航顺序正确
- 桌面端留用户验证：真实 NAS 上删除（文件/空目录/非空目录递归/两段式确认）、重命名、同共享移动（弹窗选目录）、新建文件夹、断网报错、排序开关切换前后对比
