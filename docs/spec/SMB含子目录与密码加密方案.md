# SMB 含子目录与密码加密方案

> 日期：2026-10-31　|　状态：已实施（2026-10-31，实施记录见 `docs/plans/2026-10-31-SMB含子目录与密码加密.md`，提交 a708a94…98d26e9；实现较方案新增两项加固：递归深度消费端钳制 0–5、扫描过期即弃与目录数 2000 上限/visited 防环）
> 决策：远程列表递归仅前端 BFS、复用单层目录缓存，深度下拉控制下钻层数（默认不限）；密码只在落盘边界加解密（AES-256-GCM，`enc1:` 前缀），内存与前端流程零改动；深度控制不加给本地文件夹（保持现状）。

## 1. 需求与范围

- 现状一：本地侧栏有「含子目录」（前端 BFS + 2000 文件上限，深度不可控）；SMB 远程列表只列当前目录单层。NAS 共享层级深（如 `/小说/作者/书.txt`），需要递归列出且可控深度以限制网络往返。
- 现状二：SMB 服务器密码随 store 明文写入 `read4ever.json`（README 一直标注"单机使用约定，keyring 属未来增强"）。目标：文件里不再出现明文密码。
- 非目标：本地「含子目录」不加深度控制；不引入系统 keyring（保持纯 Rust、无 FFI，iOS 门禁不受影响）；前端持有明文密码的交互（编辑弹窗预填、测试连接、`smb_put_servers` 推凭证表）不变。

## 2. 设计

### 2.1 远程列表「含子目录」+ 深度控制

**UI**（`index.html` 远程标签 listbar）：

- 过滤框左侧加「含子目录」复选框（`smb-recursive`）+ 深度下拉（`smb-depth`：`1/2/3/4/5 层/不限`），未勾选时下拉禁用。
- 不进设置中心：远程开关就地放标签里，避免设置项膨胀（本地那项进设置中心是历史原因）。

**持久化**（`types.ts` + `store.rs` + `app.ts` mergeDefaults 同步）：

- `settings.smbListRecursive: boolean`（默认 false，`#[serde(default)]`）
- `settings.smbListDepth: number`：下钻层数 1–5，**0 = 不限**（默认 0，与本地"递归到底 + 上限"语义一致；NAS 太大时用户自行降深度）。`selectedDir` 自身算第 0 层，其直接子目录算第 1 层。

**行为**（`smb.ts`，镜像 `folder.ts` 的 `collectFiles` 前端 BFS）：

1. 勾选后 `renderList` 从 `selectedDir` 逐层 `loadChildren`（复用 `childrenCache`，网络往返有缓存兜底；既有 `listSeq` 守卫丢弃过期渲染），只收 `!isDir` 条目；深度超过 `smbListDepth` 不再下钻（0 = 不限）；文件数达 `SMB_SCAN_CAP = 2000` 即停。
2. 列表行显示相对路径 `rel`（与本地递归列表一致）。
3. 扫描进行中 `smb-list-count` 显示「扫描中…」，完成后显示计数。
4. 右键菜单/缓存标记天然工作：BFS 途经目录都写入 `childrenCache`，右键按 `parentDir` 查父键能命中。
5. 切换复选框/深度：写 settings（防抖 persist）+ `renderList`，不清 `childrenCache`（缓存是单层目录级，与深度无关）。
6. 失败目录沿用 `loadChildren` 现状（toast + 缓存空数组），BFS 自然停止。
7. 后端与 `mock_backend` 零改动（递归纯前端）。

**同步项**：README 功能表「文件夹浏览」行补一句远程含子目录。无菜单/快捷键入口。

### 2.2 密码落盘加密

**边界原则**：内存中始终明文（前端 state、后端凭证表、测试连接参数），只在落盘边界处理——`save_store` 写前加密、`load_store` 读后解密。前端、编辑弹窗零改动。

**格式**：`SmbServer.password` 落盘为 `"enc1:" + base64(salt[16] ‖ nonce[12] ‖ AES-256-GCM 密文)`，密钥 = SHA-256(应用内置常量 ‖ salt)。

- 每次保存随机新 salt+nonce（同一明文两次落盘密文不同）。
- 新依赖：`aes-gcm`、`sha2`（RustCrypto 纯 Rust，iOS 门禁安全）。
- 空密码（访客登录）不加密，仍存 `""`。
- 解密失败（tag 不符 / 非法 base64）：保留原值不动——兼容手工改坏的文件，也兼容"真实密码恰好以 `enc1:` 开头"的极端情况。
- 旧配置迁移零步骤：旧明文读出即用，下次 persist 时 `save_store` 自动以密文写出。

**同步项**：README「SMB 远程浏览」段落中"密码明文保存"的说明改为"密码加密保存"。

## 3. 验证

- `store.rs` 单测：roundtrip（存→读一致）、旧明文兼容、解密失败保留原值、空密码跳过加密。
- `npm run build` 过 tsc；`cargo check`；`cargo check --target aarch64-apple-ios-sim`（iOS 门禁）。
- 浏览器 mock 手动验证：勾选含子目录递归列出、深度下拉生效、过滤/右键/缓存标记正常。
- 密码：确认 `read4ever.json` 中 password 字段为 `enc1:` 密文；旧配置文件升级后连接功能不变。
