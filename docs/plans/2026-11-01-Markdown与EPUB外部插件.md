# Markdown 与 EPUB 外部插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以外部 `.rbplugin` 插件形式新增 Markdown 与 EPUB 两种文件类型的阅读支持，Rust 侧零改动。

**Architecture:** 源码放 `plugins-dev/<id>/`（`_shared/` 公共小工具 + 两插件），`npm run build:plugins` 用 esbuild 打包自包含单文件 ESM、fflate `zipSync` 出 `.rbplugin`；宿主能力全部经既有 `PluginOpenContext` 获取。markdown 用 `marked` 渲染；epub 自写 zip 中央目录解析 + fflate `inflateSync` 按需解压，双渲染模式（跟随主题内联 DOM / 书籍样式 Shadow DOM）。浏览器演示由 `mock_backend.ts` 提供 `.md`/`.epub` 演示书并直读 `plugins-dev/*/dist/main.js` 走完整外部插件链路。

**Tech Stack:** TypeScript、esbuild、marked、fflate、DOMParser、Shadow DOM、MutationObserver。

**设计文档：** `docs/spec/2026-11-01-Markdown与EPUB外部插件方案.md`

**基线约定：** 仓库根 `/home/zhuangbin/SyncProjects/20261008/read4ever`，`main` 直接提交、中文单行标题（提交信息末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`）；前端无单测 runner，每任务以类型检查/构建为门槛 + 浏览器手动验证（boot 约 1 秒后才挂好监听，优先模拟真实 UI 点击）；界面与注释全部中文；**不改 `src/styles.css`、不改任何 Rust 代码、不改 `src/plugins/`（registry/types/loader 零改动）**；`npm run build`（tsc noUnusedLocals 等）必须全绿。

---

### Task 1: 构建设施（依赖、tsconfig、构建脚本）

**Files:**
- Modify: `package.json`（devDependencies + scripts）
- Create: `plugins-dev/tsconfig.json`
- Create: `scripts/build-plugins.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: 安装依赖**

```bash
cd /home/zhuangbin/SyncProjects/20261008/read4ever && npm install --save-dev marked fflate
```

Expected: package.json devDependencies 出现 `marked` 与 `fflate`。

- [ ] **Step 2: 写 plugins-dev/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["_shared/**/*.ts", "markdown-viewer/src/**/*.ts", "epub-viewer/src/**/*.ts"]
}
```

- [ ] **Step 3: 写 scripts/build-plugins.mjs**

```js
/* 构建全部外部插件：tsc 类型检查 → esbuild 打包单文件 ESM → fflate zipSync 打 .rbplugin。
   产物在 plugins-dev/<id>/dist/（gitignore），zip 条目仅 manifest.json + main.js。 */
import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devDir = join(root, "plugins-dev");

execSync("npx tsc --noEmit -p plugins-dev/tsconfig.json", { cwd: root, stdio: "inherit" });

for (const name of readdirSync(devDir)) {
  const dir = join(devDir, name);
  if (!statSync(dir).isDirectory() || name.startsWith("_") || name.startsWith(".")) continue;
  if (!readdirSync(dir).includes("manifest.json")) continue; // 非插件目录（tsconfig 等）
  const out = join(dir, "dist");
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(dir, "src/main.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(out, "main.js"),
    minify: false, // 产物保持可读，便于用户审查外部插件代码
    legalComments: "none",
    logLevel: "warning",
  });
  const pkg = zipSync(
    {
      "manifest.json": new Uint8Array(readFileSync(join(dir, "manifest.json"))),
      "main.js": strToU8(readFileSync(join(out, "main.js"), "utf8")),
    },
    { level: 6 }
  );
  writeFileSync(join(out, `${name}.rbplugin`), pkg);
  console.log(`[plugins] ${name} → dist/main.js + dist/${name}.rbplugin`);
}
```

- [ ] **Step 4: package.json 加 script 与 .gitignore**

package.json scripts 加（放 `gen:simptrad` 之前）：

```json
    "build:plugins": "node scripts/build-plugins.mjs",
```

`.gitignore` 追加一行：

```
plugins-dev/*/dist/
```

- [ ] **Step 5: 验证脚本语法**

```bash
node --check scripts/build-plugins.mjs && echo OK
```

Expected: `OK`。（`build:plugins` 全流程在 Task 3 有源码后再验证——tsconfig 的 include 现在还没有任何 .ts 输入，跑 tsc 会报 No inputs。）

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json plugins-dev/tsconfig.json scripts/build-plugins.mjs .gitignore
git commit -m "新增外部插件构建设施（esbuild 打包 + fflate 出 .rbplugin）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: mock 演示书与 dev 插件直读

**Files:**
- Modify: `src/mock_backend.ts`（演示 `.md`/`.epub` 书 + 从 plugins-dev 构建产物直读两插件）

- [ ] **Step 1: 演示 Markdown 内容常量**

在 `src/mock_backend.ts` 的 `ZIP_ENTRIES` 定义之后加：

```ts
/* ========== 演示 Markdown（供 markdown-viewer 外部插件测试） ========== */

const DEMO_MD_NOTE =
  "# 读书笔记\n\n" +
  "整理自近期阅读的摘录与随想，用于测试 Markdown 渲染。\n\n" +
  "## 摘录\n\n> 好的阅读器应当像一张白纸，\n> 不打扰纸上的文字。\n\n" +
  "重点段落用**加粗**标出，*斜体*用于书名，如《西游记》。\n\n" +
  "### 对照表\n\n" +
  "| 维度 | 纸书 | 电子书 |\n| --- | --- | --- |\n| 翻页 | 手指 | 滚屏 |\n| 批注 | 铅笔 | 关键词 |\n| 检索 | 目录 | 全文 |\n\n" +
  "## 待办\n\n" +
  "- [x] 通读第一章\n- [x] 摘录金句\n- [ ] 写读书报告\n\n" +
  "## 代码片段\n\n" +
  "```js\n// 自动滚屏\nscroll(() => speed * 45);\n```\n\n" +
  "## 封面\n\n" +
  "![封面](封面图片.png)\n";

const DEMO_MD_TRAVEL =
  "# 城市游记\n\n" +
  "## 第一日\n\n旧城的巷子在雨里发亮，邮局的绿漆门半开着。\n\n" +
  "## 第二日\n\n博物馆的钟停在三点，讲解员说它从三十年前就不走了。\n\n" +
  "## 附录：交通\n\n- 地铁：二号线旧城站\n- 步行：出站沿河堤十五分钟\n";
```

- [ ] **Step 2: stored zip 构造器与演示 EPUB（插在「演示图片」常量之后、「演示视频」注释之前）**

先 `grep -n "dataUrlToBuffer\|ILLUSTRATION_1" src/mock_backend.ts` 确认两名字存在。在 `GROUP_P8` 那行之后、「演示视频」注释之前插入：

```ts
/* ========== 演示 EPUB（stored zip 现构造，供 epub-viewer 外部插件测试） ========== */

/** 构造 stored（无压缩）zip 字节：条目按给定顺序写入（epub 规范要求 mimetype 首条）。
    CRC 填 0——仅作演示书打开，不会被安装，epub 插件自写解析不校验 CRC。 */
function makeStoredZip(files: Array<[name: string, data: Uint8Array]>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const put = (buf: Uint8Array): void => {
    parts.push(buf);
    offset += buf.length;
  };
  const header = (nameLen: number, compSize: number, sig: number, len: number, madeBy = -1): Uint8Array => {
    const b = new Uint8Array(len);
    const dv = new DataView(b.buffer);
    const cd = len === 46; // 是否中央目录头
    dv.setUint32(0, sig, true);
    if (madeBy >= 0) dv.setUint16(4, madeBy, true);
    dv.setUint16(cd ? 6 : 4, 20, true); // 需要的版本
    dv.setUint16(cd ? 8 : 6, 0x0800, true); // UTF-8 文件名标志
    dv.setUint16(cd ? 10 : 8, 0, true); // method 0 = stored
    dv.setUint16(cd ? 12 : 10, 0, true); // 修改时间
    dv.setUint16(cd ? 14 : 12, 0, true); // 修改日期
    dv.setUint32(cd ? 16 : 14, 0, true); // CRC32（演示不校验）
    dv.setUint32(cd ? 20 : 18, compSize, true); // 压缩后大小
    dv.setUint32(cd ? 24 : 22, compSize, true); // 原始大小
    dv.setUint16(cd ? 28 : 26, nameLen, true); // 文件名长
    dv.setUint16(cd ? 30 : 28, 0, true); // 扩展字段长
    dv.setUint16(cd ? 32 : 30, 0, true); // 注释长
    if (cd) {
      dv.setUint16(34, 0, true); // 起始盘号
      dv.setUint16(36, 0, true); // 内部属性
      dv.setUint32(38, 0, true); // 外部属性
      dv.setUint32(42, offset, true); // 本地头偏移
    }
    return b;
  };
  for (const [name, data] of files) {
    const nb = enc.encode(name);
    put(header(nb.length, data.length, 0x04034b50, 30));
    put(nb);
    put(data);
    central.push(Uint8Array.from([...header(nb.length, data.length, 0x02014b50, 46, 20), ...nb]));
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, offset, true); // 中央目录起始偏移
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const c of [...parts, ...central, eocd]) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const epubText = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeDemoEpub(coverPng: Uint8Array): Uint8Array {
  const ch = (title: string, body: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h2>${title}</h2>${body}</body></html>`;
  return makeStoredZip([
    ["mimetype", epubText("application/epub+zip")],
    [
      "META-INF/container.xml",
      epubText(
        '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
      ),
    ],
    [
      "OEBPS/content.opf",
      epubText(
        '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:demo-epub</dc:identifier><dc:title>演示之书</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/><item id="cover" href="cover.png" media-type="image/png"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>'
      ),
    ],
    [
      "OEBPS/nav.xhtml",
      epubText(
        '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h2>目录</h2><ol><li><a href="ch1.xhtml">第一章 雨夜的字条</a></li><li><a href="ch2.xhtml">第二章 旧城的钥匙</a></li><li><a href="ch3.xhtml">第三章 未寄出的信</a></li></ol></nav></body></html>'
      ),
    ],
    [
      "OEBPS/style.css",
      epubText("h2 { font-family: serif; color: #8b2323; border-bottom: 2px solid #8b2323; }\np { text-indent: 2em; margin: 0 0 0.4em; line-height: 1.7; }\n"),
    ],
    ["OEBPS/cover.png", coverPng],
    [
      "OEBPS/ch1.xhtml",
      epubText(
        ch(
          "第一章 雨夜的字条",
          "<p>陈默在整理旧书时，发现夹在书页间的一张字条。</p><p>字条上只有一行钢笔字：坐标在北方，落款在雨夜。</p><p id=\"note\">他决定按图索骥。</p><p><img src=\"cover.png\" alt=\"封面\"/></p>"
        )
      ),
    ],
    [
      "OEBPS/ch2.xhtml",
      epubText(
        ch(
          "第二章 旧城的钥匙",
          "<p>钥匙藏在邮局第三格抽屉里。</p><p>抽屉里还有一封没有寄出的信，收信人是三十年前的他自己。</p><p>详见<a href=\"ch3.xhtml\">第三章</a>，或回到<a href=\"ch1.xhtml#note\">那张字条</a>。</p>"
        )
      ),
    ],
    [
      "OEBPS/ch3.xhtml",
      epubText(
        ch("第三章 未寄出的信", "<p>信的开头写着：给未来仍会路过旧城的你。</p><p>信的结尾没有署名，只有一枚干涸的火漆印。</p>")
      ),
    ],
  ]);
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const DEMO_EPUB_DATAURL = "data:application/epub+zip;base64," + bytesToBase64(makeDemoEpub(new Uint8Array(dataUrlToBuffer(ILLUSTRATION_1))));
```

- [ ] **Step 3: 虚拟文件系统挂载**

`mockFsRoot` 里 `"封面图片.png": mockFile(COVER_PNG),` 一行之前加两个 `.md`、之后加 `.epub`：

```ts
  "笔记.md": mockFile(DEMO_MD_NOTE),
  "游记.md": mockFile(DEMO_MD_TRAVEL),
```

```ts
  "演示之书.epub": mockFile(DEMO_EPUB_DATAURL),
```

- [ ] **Step 4: dev 插件直读（list_plugins / read_plugin_file 扩展）**

在 `DEMO_PLUGIN_JS` 常量之后加：

```ts
/* dev 构建产物直读：vite 开发服务器按项目相对路径供应文件，
   未构建（dist/ 不存在）则静默跳过；manifest 元信息在此同步一份（构建时注意同步 manifest.json）。 */
const DEV_PLUGINS = [
  { id: "markdown-viewer", name: "Markdown 查看", version: "1.0.0", description: "渲染 Markdown 为富文本阅读视图（跟随阅读主题、大纲面板）", extensions: [".md", ".markdown", ".mdown"] },
  { id: "epub-viewer", name: "EPUB 查看", version: "1.0.0", description: "EPUB 阅读：目录导航、进度记忆、跟随主题/书籍样式双模式", extensions: [".epub"] },
];
const devMainJs = new Map<string, string>();
const devPluginsReady = (async () => {
  for (const p of DEV_PLUGINS) {
    try {
      const r = await fetch(`/plugins-dev/${p.id}/dist/main.js`);
      if (r.ok) devMainJs.set(p.id, await r.text());
    } catch {
      /* 未构建或非 dev 环境：跳过 */
    }
  }
})();
```

`case "list_plugins":` 改为：

```ts
      case "list_plugins":
        return devPluginsReady.then(() => [
          JSON.parse(JSON.stringify(DEMO_PLUGIN_PKG)),
          ...DEV_PLUGINS.filter((p) => devMainJs.has(p.id)).map((p) => ({
            ...p,
            author: "Read4Ever",
            api: 1,
            entry: "main.js",
            dir: "(plugins-dev 构建产物)",
          })),
        ]);
```

`case "read_plugin_file":` 改为：

```ts
      case "read_plugin_file":
        return devPluginsReady.then(
          () =>
            new TextEncoder().encode(
              args.id === "hex-viewer" ? DEMO_PLUGIN_JS : devMainJs.get(String(args.id)) ?? ""
            ).buffer
        );
```

- [ ] **Step 5: 验证构建与浏览器回归**

```bash
npm run build
npm run dev
```

浏览器检查（boot 等约 1 秒）：左侧文件夹栏 → 书库 → 应看到 `笔记.md`/`游记.md`/`演示之书.epub`（此时无插件接管，显示为不可打开属预期）；菜单 工具 → 插件管理：hex-viewer 仍正常列出（未构建 dist 时仅它一条）。

- [ ] **Step 6: 提交**

```bash
git add src/mock_backend.ts
git commit -m "mock 增加演示 Markdown/EPUB 书与 plugins-dev 构建产物直读

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: _shared 公共模块（主题跟随 / 编码探测 / 净化 / 路径）

**Files:**
- Create: `plugins-dev/_shared/theme.ts`
- Create: `plugins-dev/_shared/decode.ts`
- Create: `plugins-dev/_shared/sanitize.ts`
- Create: `plugins-dev/_shared/paths.ts`

- [ ] **Step 1: theme.ts**

```ts
/* 主题跟随：外部插件不能 import 宿主模块——颜色读根元素 CSS 变量（applyTheme 会同时更新它们），
   字体/字号/行距读 #reader-content 的计算样式（applyTheme 直写内联样式）。
   watchTheme 监听两处 style 属性变化回调（换主题/换字体实时跟随）；返回解除函数。 */
export interface ThemeSnapshot {
  bg: string;
  text: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

export function readTheme(): ThemeSnapshot {
  const root = getComputedStyle(document.documentElement);
  const reader = document.getElementById("reader-content");
  const rc = reader ? getComputedStyle(reader) : null;
  return {
    bg: root.getPropertyValue("--reader-bg").trim() || "#f5f0e0",
    text: root.getPropertyValue("--reader-text").trim() || "#333333",
    fontFamily: rc?.fontFamily || "serif",
    fontSize: rc?.fontSize || "18px",
    lineHeight: rc?.lineHeight || "1.8",
  };
}

export function watchTheme(cb: () => void): () => void {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  const reader = document.getElementById("reader-content");
  if (reader) obs.observe(reader, { attributes: true, attributeFilter: ["style"] });
  return () => obs.disconnect();
}
```

- [ ] **Step 2: decode.ts**

```ts
/* 编码探测（宿主 encoding.rs 的前端轻量版）：BOM → UTF-8 严格 → GBK 回退 */
export function decodeText(bytes: Uint8Array): { text: string; label: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(bytes), label: "UTF-16LE" };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(bytes), label: "UTF-16BE" };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), label: "UTF-8" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), label: "UTF-8" };
  } catch {
    return { text: new TextDecoder("gbk").decode(bytes), label: "GBK" };
  }
}

/** XML/XHTML 解码：按声明标签（前 512 字节内）取编码，未知或缺失回退 UTF-8 */
export function decodeXml(bytes: Uint8Array): string {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 512));
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  if (m) {
    try {
      return new TextDecoder(m[1]).decode(bytes);
    } catch {
      /* 未知编码标签：回退 UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
```

- [ ] **Step 3: sanitize.ts**

```ts
/* 轻量净化：剥危险元素、事件属性与危险协议 URL（markdown 渲染结果与 epub 章节内容共用） */
const STRIP_TAGS = new Set([
  "script", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "button", "select", "textarea",
]);
const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "background"]);

export function sanitizeTree(root: Element): void {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const remove: Element[] = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n as Element;
    if (STRIP_TAGS.has(el.tagName.toLowerCase())) {
      remove.push(el); // 连子树一起移除，先收集后删避免遍历中断
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  for (const el of remove) el.remove();
}
```

- [ ] **Step 4: paths.ts**

```ts
/* 路径工具：zip 复合路径（"zip路径::条目名"）感知的目录切分与相对路径解析 */
const ZIP_RE = /^(.+\.zip)::(.+)$/i;

/** 目录部分（zip 复合路径保留 "zip::目录" 前缀；根目录原样返回） */
export function dirOf(path: string): string {
  const m = path.match(ZIP_RE);
  if (m) {
    const i = Math.max(m[2].lastIndexOf("/"), m[2].lastIndexOf("\\"));
    return i > 0 ? `${m[1]}::${m[2].slice(0, i)}` : `${m[1]}::`;
  }
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/** 文件名部分（zip 复合路径取条目名） */
export function baseOf(path: string): string {
  const m = path.match(ZIP_RE);
  const s = m ? m[2] : path;
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

/** 段式相对路径解析：dir 为目录段（无 zip 复合前缀），rel 支持 ../ ./ 与 URL 解码 */
function resolveSegs(dir: string, rel: string): string {
  let r = rel;
  try {
    r = decodeURIComponent(rel);
  } catch {
    /* 已是原始字符：保持 */
  }
  const segs = dir ? dir.split(/[\\/]/).filter(Boolean) : [];
  for (const part of r.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

/** 在基础目录（dirOf 的产物，可含 "zip::" 复合前缀）下解析相对路径 rel */
export function resolveUnder(dir: string, rel: string): string {
  const m = dir.match(ZIP_RE);
  if (!m) return resolveSegs(dir, rel);
  return `${m[1]}::${resolveSegs(m[2], rel)}`;
}
```

- [ ] **Step 5: 构建验证**

```bash
npm run build:plugins
```

Expected: tsc 通过（尚无插件目录，循环体不执行），退出码 0。

- [ ] **Step 6: 提交**

```bash
git add plugins-dev/_shared
git commit -m "外部插件公共模块：主题跟随/编码探测/净化/zip 路径工具

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: markdown-viewer 插件

**Files:**
- Create: `plugins-dev/markdown-viewer/manifest.json`
- Create: `plugins-dev/markdown-viewer/src/main.ts`

- [ ] **Step 1: manifest.json**

```json
{
  "id": "markdown-viewer",
  "name": "Markdown 查看",
  "version": "1.0.0",
  "description": "渲染 Markdown 为富文本阅读视图（跟随阅读主题、大纲面板）",
  "author": "Read4Ever",
  "api": 1,
  "entry": "main.js",
  "extensions": [".md", ".markdown", ".mdown"]
}
```

- [ ] **Step 2: 插件主体 src/main.ts（完整文件）**

```ts
/* Markdown 查看插件：渲染 .md 为富文本阅读视图，跟随阅读主题。
   自包含单文件 ESM（marked 随包打入）；宿主能力全部经 PluginOpenContext 递入。 */
import { marked } from "marked";
import type { MenuItemDef } from "../../../src/plugins/dropdown";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import { decodeText } from "../../_shared/decode";
import { baseOf, dirOf, resolveUnder } from "../../_shared/paths";
import { sanitizeTree } from "../../_shared/sanitize";
import { readTheme, watchTheme } from "../../_shared/theme";

const PID = "markdown-viewer";

/** 模块级偏好与存活实例表（插件菜单 action 需要触达当前实例） */
let prefSource = false;
const openViews = new Set<MarkdownView>();

const CSS = `
.rbmd-scroll { position: absolute; inset: 0; overflow: auto; outline: none; }
.rbmd-body { max-width: 760px; margin: 0 auto; padding: 28px 24px 48px; word-wrap: break-word; }
.rbmd-body h1, .rbmd-body h2, .rbmd-body h3, .rbmd-body h4, .rbmd-body h5, .rbmd-body h6 { line-height: 1.35; margin: 1.2em 0 0.5em; font-weight: 600; }
.rbmd-body h1 { font-size: 1.6em; } .rbmd-body h2 { font-size: 1.4em; } .rbmd-body h3 { font-size: 1.2em; }
.rbmd-body p { margin: 0 0 0.75em; text-align: justify; }
.rbmd-body blockquote { margin: 0.8em 0; padding: 0.2em 1em; border-left: 3px solid var(--accent, #4a9eff); opacity: 0.85; }
.rbmd-body pre { padding: 10px 12px; border-radius: 6px; background: rgba(128,128,128,.14); overflow: auto; font-size: 0.85em; line-height: 1.6; }
.rbmd-body code { font-family: Consolas, Menlo, monospace; font-size: 0.9em; }
.rbmd-body :not(pre) > code { padding: 1px 5px; border-radius: 4px; background: rgba(128,128,128,.14); }
.rbmd-body table { border-collapse: collapse; margin: 0.8em 0; font-size: 0.95em; }
.rbmd-body th, .rbmd-body td { border: 1px solid rgba(128,128,128,.45); padding: 4px 12px; }
.rbmd-body img { max-width: 100%; height: auto; }
.rbmd-body a { color: var(--accent, #4a9eff); }
.rbmd-body hr { border: none; border-top: 1px solid rgba(128,128,128,.4); margin: 1.4em 0; }
.rbmd-body input[type="checkbox"] { margin-right: 4px; }
.rbmd-src { margin: 0; padding: 20px 24px; font: 0.9em/1.7 Consolas, Menlo, monospace; white-space: pre-wrap; }
.rbmd-bar { position: absolute; top: 8px; left: 8px; z-index: 5; display: flex; gap: 6px; }
.rbmd-bar button { border: 1px solid var(--ui-border, #555); background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.rbmd-bar button:hover { background: var(--ui-hover, #3d3d3d); }
.rbmd-outline { position: absolute; top: 0; left: 0; bottom: 0; width: 220px; z-index: 6; overflow: auto; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-right: 1px solid var(--ui-border, #555); padding: 8px 0; }
.rbmd-outline.hidden { display: none; }
.rbmd-outline-row { display: block; width: 100%; text-align: left; background: none; border: none; color: inherit; font-size: 13px; padding: 5px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rbmd-outline-row:hover { background: var(--ui-hover, #3d3d3d); }
.rbmd-outline-row.active { color: var(--accent, #4a9eff); }
.rbmd-img-miss { opacity: 0.55; font-size: 0.85em; }
`;

class MarkdownView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private scroll!: HTMLElement;
  private body!: HTMLElement;
  private srcView!: HTMLElement;
  private outline!: HTMLElement;
  private outlineRows: HTMLElement[] = [];
  private headings: HTMLElement[] = [];
  private blobUrls: string[] = [];
  private unwatch: (() => void) | null = null;
  private text = "";
  private encLabel = "UTF-8";
  private asSource = false;
  private active = true;
  private idx = 0;
  private siblings: string[] = [];
  private path = "";
  private scrollTimer = 0;

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.path = ctx.path;
    this.siblings = ctx.siblings;
    this.idx = ctx.siblingIndex;
    this.asSource = prefSource = ctx.getSetting("viewSource", false);
    this.buildDom();
    this.unwatch = watchTheme(() => this.applyTheme());
    const { text, label } = decodeText(ctx.bytes);
    this.text = text;
    this.encLabel = label;
    this.applyTheme();
    this.renderView();
    this.syncStatus();
    openViews.add(this);
  }

  private buildDom(): void {
    const host = this.ctx.host;
    const style = document.createElement("style");
    style.textContent = CSS;
    const bar = document.createElement("div");
    bar.className = "rbmd-bar plugin-topbar";
    const btnOutline = document.createElement("button");
    btnOutline.textContent = "☰ 大纲";
    btnOutline.addEventListener("click", () => this.toggleOutline());
    this.outline = document.createElement("div");
    this.outline.className = "rbmd-outline hidden";
    this.scroll = document.createElement("div");
    this.scroll.className = "rbmd-scroll";
    this.scroll.tabIndex = 0;
    this.body = document.createElement("div");
    this.body.className = "rbmd-body";
    this.srcView = document.createElement("pre");
    this.srcView.className = "rbmd-src hidden";
    this.scroll.append(this.body, this.srcView);
    bar.appendChild(btnOutline);
    host.append(style, bar, this.outline, this.scroll);
    this.scroll.addEventListener("scroll", () => this.onScroll(), { passive: true });
  }

  private applyTheme(): void {
    const t = readTheme();
    this.scroll.style.background = t.bg;
    this.body.style.color = t.text;
    this.body.style.fontFamily = t.fontFamily;
    this.body.style.fontSize = t.fontSize;
    this.body.style.lineHeight = t.lineHeight;
    this.srcView.style.color = t.text;
    this.srcView.style.background = t.bg;
  }

  private renderView(): void {
    this.revokeBlobs();
    if (this.asSource) {
      this.body.classList.add("hidden");
      this.srcView.classList.remove("hidden");
      this.srcView.textContent = this.text || "(空文件)";
      this.outline.classList.add("hidden");
      this.outlineRows = [];
      return;
    }
    this.srcView.classList.add("hidden");
    this.body.classList.remove("hidden");
    this.body.innerHTML = marked.parse(this.text, { async: false, gfm: true, breaks: false }) as string;
    sanitizeTree(this.body);
    this.buildOutline();
    void this.fixImages();
    this.scroll.scrollTop = 0;
  }

  private buildOutline(): void {
    this.outline.innerHTML = "";
    this.outlineRows = [];
    this.headings = [];
    for (const h of this.body.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      const el = h as HTMLElement;
      el.id = el.id || `rbmd-h-${this.headings.length}`;
      this.headings.push(el);
      const row = document.createElement("button");
      row.className = "rbmd-outline-row";
      row.style.paddingLeft = `${8 + (Number(el.tagName[1]) - 1) * 14}px`;
      row.textContent = el.textContent || "(无标题)";
      row.addEventListener("click", () => el.scrollIntoView({ block: "start" }));
      this.outline.appendChild(row);
      this.outlineRows.push(row);
    }
  }

  /** 相对路径图片经 ctx.loadBytes 读同容器文件转 blob URL；越界/缺失替换为占位文字 */
  private async fixImages(): Promise<void> {
    const dir = dirOf(this.path);
    for (const img of [...this.body.querySelectorAll("img[src]")]) {
      const el = img as HTMLImageElement;
      const raw = el.getAttribute("src") || "";
      if (/^(https?:|data:|blob:)/i.test(raw)) continue; // 外链保持原样
      const target = resolveUnder(dir, raw);
      try {
        const bytes = await this.ctx.loadBytes(target);
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(target) }));
        this.blobUrls.push(url);
        el.src = url;
      } catch {
        const span = document.createElement("span");
        span.className = "rbmd-img-miss";
        span.textContent = `🖼 未找到图片：${raw}`;
        el.replaceWith(span);
      }
    }
  }

  private toggleOutline(): void {
    if (this.asSource) {
      this.ctx.toast("源码模式下无大纲");
      return;
    }
    this.outline.classList.toggle("hidden");
    this.onScroll();
  }

  private onScroll(): void {
    if (this.asSource || this.outline.classList.contains("hidden")) return;
    window.clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => {
      let cur = -1;
      for (let i = 0; i < this.headings.length; i++) {
        if (this.headings[i].getBoundingClientRect().top <= 90) cur = i;
      }
      this.outlineRows.forEach((r, i) => r.classList.toggle("active", i === cur));
    }, 150);
  }

  /** 上一份/下一份：siblings 接续（跨目录/跨 zip 条目） */
  async navFile(delta: number): Promise<void> {
    const ni = this.idx + delta;
    if (ni < 0 || ni >= this.siblings.length) {
      this.ctx.toast(delta < 0 ? "已是第一份" : "已是最后一份");
      return;
    }
    try {
      const bytes = await this.ctx.loadBytes(this.siblings[ni]);
      this.idx = ni;
      this.path = this.siblings[ni];
      this.ctx.path = this.path; // 宿主 activeFilePath() 跟随
      const { text, label } = decodeText(bytes);
      this.text = text;
      this.encLabel = label;
      this.renderView();
      this.syncStatus();
    } catch (e) {
      this.ctx.toast(`读取失败：${e}`);
    }
  }

  /** 渲染/源码切换（公开：插件菜单模块层回调触达实例） */
  setSource(on: boolean): void {
    this.asSource = prefSource = on;
    this.ctx.setSetting("viewSource", on);
    this.renderView();
    this.syncStatus();
  }

  private syncStatus(): void {
    const name = baseOf(this.path);
    this.ctx.setStatus({
      title: name,
      file: name,
      encoding: `Markdown · ${this.encLabel}`,
      position: `第 ${this.idx + 1}/${this.siblings.length} 份`,
      mode: `模式: ${this.asSource ? "源码" : "渲染"}`,
      display: "-",
    });
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  deactivate(): void {
    openViews.delete(this);
    this.unwatch?.();
    window.clearTimeout(this.scrollTimer);
    this.revokeBlobs();
  }

  private revokeBlobs(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
  }
}

function mimeOf(path: string): string {
  const e = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  if (e === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

const plugin: Read4EverPlugin = {
  id: PID,
  name: "Markdown 查看",
  version: "1.0.0",
  description: "渲染 Markdown 为富文本阅读视图（跟随阅读主题、大纲面板）",
  extensions: [".md", ".markdown", ".mdown"],
  createView: () => new MarkdownView(),
  menu: (): MenuItemDef[] => [
    {
      label: "渲染显示",
      checked: () => !prefSource,
      action: () => openViews.forEach((v) => v.setSource(false)),
    },
    {
      label: "源码显示",
      checked: () => prefSource,
      action: () => openViews.forEach((v) => v.setSource(true)),
    },
  ],
};

export default plugin;
```

（`this.active` 字段当前未在方法中判断——保留存值，与 image-viewer 的 `setActive` 约定一致，供后续需要；若 tsc 报 noUnusedLocals 不影响字段，仅方法参数 `on` 已使用。）

- [ ] **Step 3: 构建**

```bash
npm run build:plugins
```

Expected: 输出 `[plugins] markdown-viewer → dist/main.js + dist/markdown-viewer.rbplugin`，无 tsc 报错；`ls plugins-dev/markdown-viewer/dist/` 产物存在。

- [ ] **Step 4: 浏览器验证**

```bash
npm run dev
```

浏览器（boot 约 1 秒后）：
1. 工具 → 插件管理：应出现「Markdown 查看」行（外部徽标、启用开关）。若未出现：DevTools Network 过滤 `plugins-dev`，看 `main.js` 请求是否 404——404 说明 vite 未按项目相对路径供应，检查 dist 是否已构建、URL 是否为 `/plugins-dev/markdown-viewer/dist/main.js`。
2. 文件夹栏 → 书库 → 双击 `笔记.md`：渲染视图（标题/表格/任务列表/代码块/引用），颜色字体与当前主题一致；`![封面](封面图片.png)` 显示图片。
3. 外观面板切换主题：渲染区颜色/字体实时跟随。
4. ☰ 大纲：面板出现，点击「对照表」滚动定位；滚动时当前标题高亮。
5. `Ctrl+PgDn`：切到 `游记.md`（状态栏「第 2/2 份」），`Ctrl+PgUp` 回来。
6. 菜单栏「插件」→ Markdown 查看 → 源码显示：切换为纯文本；再切回渲染。
7. Esc 关闭视图回文本层；DevTools 控制台无报错。

- [ ] **Step 5: 提交**

```bash
git add plugins-dev/markdown-viewer
git commit -m "新增 markdown-viewer 外部插件（渲染/源码/大纲/接续/主题跟随）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: epub 解析层（minizip + opf）

**Files:**
- Create: `plugins-dev/epub-viewer/manifest.json`
- Create: `plugins-dev/epub-viewer/src/minizip.ts`
- Create: `plugins-dev/epub-viewer/src/opf.ts`
- Create: `plugins-dev/epub-viewer/src/main.ts`（占位，Task 6 替换）

- [ ] **Step 1: manifest.json**

```json
{
  "id": "epub-viewer",
  "name": "EPUB 查看",
  "version": "1.0.0",
  "description": "EPUB 阅读：目录导航、进度记忆、跟随主题/书籍样式双模式",
  "author": "Read4Ever",
  "api": 1,
  "entry": "main.js",
  "extensions": [".epub"]
}
```

- [ ] **Step 2: minizip.ts（zip 中央目录只读解析，zipfile.rs 的 JS 翻版）**

```ts
/* zip 中央目录只读解析（宿主 zipfile.rs 的 JS 翻版）：EOCD（含 ZIP64）→ 条目表 → 按需读取。
   仅支持常规 zip（epub 均满足）；压缩条目走 fflate inflateSync，stored 直接切片。 */
import { inflateSync } from "fflate";
import { decodeXml } from "../../_shared/decode";

export interface ZipEntry {
  name: string;
  method: number; // 0=stored 8=deflate
  compSize: number;
  size: number;
  localOffset: number;
}

export interface MiniZip {
  entries: Map<string, ZipEntry>;
  /** 读条目原始字节（LRU 缓存由调用方另行叠加） */
  read(name: string): Uint8Array;
  /** 读条目为文本（按 XML 声明/UTF-8） */
  readText(name: string): string;
}

const MAX_ENTRY = 64 * 1024 * 1024; // 单条目 64MB 上限

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number): number => u32(b, o) + u32(b, o + 4) * 0x100000000;

export function parseZip(data: Uint8Array): MiniZip {
  // EOCD 自尾部回扫（定长 22 + 注释最长 65535）
  let eocd = -1;
  const scanStart = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= scanStart; i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/epub 文件（未找到目录尾）");
  let count = u16(data, eocd + 10);
  let cdOffset = u32(data, eocd + 16);
  // ZIP64：定位器在 EOCD 前 20 字节
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(data, loc) === 0x07064b50) {
      const z64 = u64(data, loc + 8);
      if (u32(data, z64) === 0x06064b50) {
        count = u64(data, z64 + 32);
        cdOffset = u64(data, z64 + 48);
      }
    }
  }
  if (count > 1_048_576) throw new Error("zip 条目数异常");

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(data, p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = u16(data, p + 10);
    let compSize = u32(data, p + 20);
    let size = u32(data, p + 24);
    const nameLen = u16(data, p + 28);
    const extraLen = u16(data, p + 30);
    const commentLen = u16(data, p + 32);
    let localOffset = u32(data, p + 42);
    const name = new TextDecoder("utf-8").decode(data.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 扩展字段：仅对 0xFFFFFFFF 的字段按 size→compSize→offset 顺序补读
    if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      let q = p + 46 + nameLen;
      const qEnd = q + extraLen;
      while (q + 4 <= qEnd) {
        const id = u16(data, q);
        const sz = u16(data, q + 2);
        if (id === 0x0001) {
          let f = q + 4;
          if (size === 0xffffffff) {
            size = u64(data, f);
            f += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = u64(data, f);
            f += 8;
          }
          if (localOffset === 0xffffffff) localOffset = u64(data, f);
          break;
        }
        q += 4 + sz;
      }
    }
    if (!name.endsWith("/")) entries.set(name, { name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name: string): Uint8Array => {
    const e = entries.get(name);
    if (!e) throw new Error(`epub 内缺少文件: ${name}`);
    if (e.size > MAX_ENTRY) throw new Error(`条目过大（${(e.size / 1048576).toFixed(0)}MB）: ${name}`);
    if (u32(data, e.localOffset) !== 0x04034b50) throw new Error(`zip 本地头损坏: ${name}`);
    const nameLen = u16(data, e.localOffset + 26);
    const extraLen = u16(data, e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = data.subarray(start, start + e.compSize);
    if (e.method === 0) return raw.slice(); // slice 脱离原大缓冲，避免整包长期驻留
    if (e.method === 8) return inflateSync(raw);
    throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);
  };
  return { entries, read, readText: (n) => decodeXml(read(n)) };
}
```

- [ ] **Step 3: opf.ts（container/OPF/spine/TOC 解析）**

```ts
/* EPUB 结构解析：container.xml → OPF（manifest+spine）→ 目录（EPUB3 nav / EPUB2 NCX） */
import type { MiniZip } from "./minizip";

export interface TocEntry {
  label: string;
  href: string; // 解析后的 zip 条目路径（不含锚点）
  anchor: string; // #后锚点（可为空）
  depth: number;
}

export interface EpubBook {
  version: "2" | "3";
  title: string;
  /** spine 顺序的 XHTML 路径（已滤 linear="no"） */
  spine: string[];
  toc: TocEntry[];
  /** 全部样式表内容（书籍样式模式注入 shadow root） */
  cssText: string;
}

function parseXml(text: string, label: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${label} 解析失败`);
  return doc;
}

function dirEntry(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** 拆锚点 + 相对路径解析（段式，同 _shared/paths 的 resolveSegs；epub 内路径无 zip 复合前缀） */
function resolveHref(dir: string, href: string): { path: string; anchor: string } {
  const si = href.indexOf("#");
  const anchor = si >= 0 ? href.slice(si + 1) : "";
  let raw = si >= 0 ? href.slice(0, si) : href;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* 已是原始字符：保持 */
  }
  const segs = dir ? dir.split(/[\\/]/).filter(Boolean) : [];
  for (const part of raw.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return { path: segs.join("/"), anchor };
}

export function parseEpub(zip: MiniZip): EpubBook {
  // container.xml → OPF 路径
  if (!zip.entries.has("META-INF/container.xml")) throw new Error("缺少 META-INF/container.xml");
  const cdoc = parseXml(zip.readText("META-INF/container.xml"), "container.xml");
  const opfPath = cdoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path") || "";
  if (!opfPath || !zip.entries.has(opfPath)) throw new Error(`OPF 不存在: ${opfPath}`);

  const odoc = parseXml(zip.readText(opfPath), "OPF");
  const verAttr = odoc.documentElement.getAttribute("version") || "2.0";
  const version: "2" | "3" = verAttr.startsWith("3") ? "3" : "2";
  const opfDir = dirEntry(opfPath);

  // manifest：id → 解析后 href（锚点已在解析时丢弃，manifest href 一般不带）
  const items = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const it of odoc.getElementsByTagName("item")) {
    const id = it.getAttribute("id") || "";
    const href = it.getAttribute("href") || "";
    if (!id || !href) continue;
    items.set(id, {
      href: resolveHref(opfDir, href).path,
      mediaType: it.getAttribute("media-type") || "",
      properties: it.getAttribute("properties") || "",
    });
  }

  // spine（滤 linear="no"）
  const spine: string[] = [];
  const spineEl = odoc.getElementsByTagName("spine")[0];
  for (const ref of odoc.getElementsByTagName("itemref")) {
    if (ref.getAttribute("linear") === "no") continue;
    const href = items.get(ref.getAttribute("idref") || "")?.href;
    if (href && !spine.includes(href)) spine.push(href);
  }
  if (spine.length === 0) throw new Error("spine 为空");

  // 标题（dc:title）
  const title =
    [...odoc.getElementsByTagNameNS("*", "title")].map((t) => t.textContent?.trim() || "").find(Boolean) || "";

  // 目录：EPUB3 nav（properties 含 nav）优先，回退 EPUB2 NCX
  const toc: TocEntry[] = [];
  const navItem = [...items.values()].find((i) => i.properties.split(/\s+/).includes("nav"));
  if (navItem && zip.entries.has(navItem.href)) {
    const ndoc = parseXml(zip.readText(navItem.href), "nav.xhtml");
    const navDir = dirEntry(navItem.href);
    const navs = [...ndoc.getElementsByTagName("nav")];
    const tocNav =
      navs.find(
        (n) =>
          n.getAttribute("epub:type") === "toc" ||
          n.getAttributeNS("http://www.idpf.org/2007/ops", "type") === "toc"
      ) || navs[0];
    const walk = (ol: Element, depth: number): void => {
      for (const li of ol.children) {
        if (li.tagName.toLowerCase() !== "li") continue;
        const a = li.querySelector("a[href]");
        if (a) {
          const { path, anchor } = resolveHref(navDir, a.getAttribute("href") || "");
          toc.push({ label: a.textContent?.trim() || "(无标题)", href: path, anchor, depth });
        }
        const sub = li.querySelector(":scope > ol");
        if (sub) walk(sub as Element, depth + 1);
      }
    };
    const rootOl = tocNav?.querySelector("ol");
    if (rootOl) walk(rootOl as Element, 0);
  }
  if (toc.length === 0 && spineEl) {
    const ncxId = spineEl.getAttribute("toc") || "";
    const ncxHref =
      (ncxId && items.get(ncxId)?.href) ||
      [...items.values()].find((i) => i.mediaType === "application/x-dtbncx+xml")?.href;
    if (ncxHref && zip.entries.has(ncxHref)) {
      const ndoc = parseXml(zip.readText(ncxHref), "NCX");
      const ncxDir = dirEntry(ncxHref);
      const walk = (parent: Element, depth: number): void => {
        for (const np of parent.children) {
          if (np.tagName.toLowerCase() !== "navpoint") continue;
          const label = np.getElementsByTagName("text")[0]?.textContent?.trim() || "";
          const src = np.getElementsByTagName("content")[0]?.getAttribute("src") || "";
          if (src) {
            const { path, anchor } = resolveHref(ncxDir, src);
            toc.push({ label: label || "(无标题)", href: path, anchor, depth });
          }
          walk(np, depth + 1);
        }
      };
      const navMap = ndoc.getElementsByTagName("navMap")[0] || ndoc.documentElement;
      walk(navMap, 0);
    }
  }
  if (toc.length === 0) {
    // 兜底：按 spine 生成占位目录
    spine.forEach((href, i) => toc.push({ label: `第 ${i + 1} 节`, href, anchor: "", depth: 0 }));
  }

  // 样式表：全部 text/css 条目合并（shadow root 内生效，互不污染宿主）
  let cssText = "";
  for (const it of items.values()) {
    if (it.mediaType === "text/css" && zip.entries.has(it.href)) {
      try {
        cssText += zip.readText(it.href) + "\n";
      } catch {
        /* 单个 css 读失败不阻塞 */
      }
    }
  }

  return { version, title, spine, toc, cssText };
}
```

- [ ] **Step 4: 占位入口 + 构建验证**

创建 `plugins-dev/epub-viewer/src/main.ts`：

```ts
/* EPUB 查看插件入口（视图层下一任务替换本文件） */
const plugin = {
  id: "epub-viewer",
  name: "EPUB 查看",
  version: "1.0.0",
  description: "EPUB 阅读：目录导航、进度记忆、跟随主题/书籍样式双模式",
  extensions: [".epub"],
};
export default plugin;
```

```bash
npm run build:plugins
```

Expected: 两行产物输出（markdown-viewer 与 epub-viewer），tsc 零报错。（占位包不安装、`open` 缺失会在真安装时被 loader 校验拦下，Task 6 会补全——浏览器 demo 此刻若双击 epub 报「缺少 open」属预期。）

- [ ] **Step 5: 提交**

```bash
git add plugins-dev/epub-viewer
git commit -m "epub-viewer 解析层：zip 中央目录按需读取与 OPF/目录解析

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: epub 视图层（渲染/导航/进度/菜单）

**Files:**
- Modify: `plugins-dev/epub-viewer/src/main.ts`（整文件替换占位）

- [ ] **Step 1: 完整 main.ts**

```ts
/* EPUB 查看插件：逐章渲染（跟随主题 / 书籍样式 Shadow DOM 双模式）、目录跳章、
   上一章/下一章（navFile）、按书路径记忆进度。自包含单文件 ESM。 */
import type { MenuItemDef } from "../../../src/plugins/dropdown";
import type { PluginOpenContext, PluginViewInstance, Read4EverPlugin } from "../../../src/plugins/types";
import { decodeXml } from "../../_shared/decode";
import { baseOf } from "../../_shared/paths";
import { sanitizeTree } from "../../_shared/sanitize";
import { readTheme, watchTheme } from "../../_shared/theme";
import { parseZip, type MiniZip } from "./minizip";
import { parseEpub, type EpubBook } from "./opf";

const PID = "epub-viewer";
const POS_LIMIT = 200; // 进度记忆条数上限（LRU）

let prefMode: "theme" | "book" = "theme";
const openViews = new Set<EpubView>();

const CSS = `
.rbepub-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 5; display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-bottom: 1px solid var(--ui-border, #555); font-size: 13px; height: 30px; box-sizing: border-box; }
.rbepub-bar button { border: 1px solid var(--ui-border, #555); background: var(--ui-bg, #2b2b2b); color: inherit; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.rbepub-bar button:hover { background: var(--ui-hover, #3d3d3d); }
.rbepub-bar button:disabled { opacity: 0.4; cursor: default; }
.rbepub-title { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rbepub-scroll { position: absolute; inset: 30px 0 0 0; overflow: auto; outline: none; }
.rbepub-content { max-width: 760px; margin: 0 auto; padding: 24px 24px 48px; }
.rbepub-content p { margin: 0 0 0.75em; text-align: justify; }
.rbepub-content img { max-width: 100%; height: auto; }
.rbepub-content a { color: var(--accent, #4a9eff); }
.rbepub-toc { position: absolute; top: 30px; left: 0; bottom: 0; width: 240px; z-index: 6; overflow: auto; background: var(--panel-bg, #1e1e1e); color: var(--ui-text, #e0e0e0); border-right: 1px solid var(--ui-border, #555); padding: 8px 0; }
.rbepub-toc.hidden { display: none; }
.rbepub-toc-row { display: block; width: 100%; text-align: left; background: none; border: none; color: inherit; font-size: 13px; padding: 5px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rbepub-toc-row:hover { background: var(--ui-hover, #3d3d3d); }
.rbepub-toc-row.active { color: var(--accent, #4a9eff); }
.rbepub-empty { padding: 40px; text-align: center; opacity: 0.6; }
`;

interface SavedPos {
  i: number;
  r: number; // 章内滚动比 0..1
  t: number; // 时间戳（LRU 淘汰用）
}

class EpubView implements PluginViewInstance {
  private ctx!: PluginOpenContext;
  private zip!: MiniZip;
  private book!: EpubBook;
  private spineIdx = 0;
  private mode: "theme" | "book" = "theme";
  private scroll!: HTMLElement;
  private mount!: HTMLElement;
  private tocPanel!: HTMLElement;
  private titleEl!: HTMLElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private blobUrls: string[] = [];
  private lru = new Map<string, Uint8Array>();
  private unwatch: (() => void) | null = null;
  private saveTimer = 0;
  private active = true;
  private chapterTitle = "";
  private shadow: ShadowRoot | null = null;
  private restoreRatio: number | null = null;
  private ready = false; // 首章挂载完成前不落进度（防覆盖存档）

  async open(ctx: PluginOpenContext): Promise<void> {
    this.ctx = ctx;
    this.mode = ctx.getSetting<"theme" | "book">("styleMode", "theme");
    try {
      this.zip = parseZip(ctx.bytes);
      this.book = parseEpub(this.zip);
    } catch (e) {
      ctx.toast(`EPUB 解析失败：${e}`);
      ctx.closeView();
      return;
    }
    this.buildDom();
    this.unwatch = watchTheme(() => this.applyTheme());
    const rec = this.readPos();
    const startIdx = rec && rec.i < this.book.spine.length ? rec.i : 0;
    this.restoreRatio = rec ? rec.r : 0;
    if (rec && startIdx > 0) ctx.toast("已续读上次位置");
    await this.renderSpine(startIdx);
    openViews.add(this);
  }

  private buildDom(): void {
    const host = this.ctx.host;
    const style = document.createElement("style");
    style.textContent = CSS;
    const bar = document.createElement("div");
    bar.className = "rbepub-bar plugin-topbar";
    const btnToc = document.createElement("button");
    btnToc.textContent = "☰ 目录";
    btnToc.addEventListener("click", () => this.tocPanel.classList.toggle("hidden"));
    this.prevBtn = document.createElement("button");
    this.prevBtn.textContent = "‹ 上一章";
    this.prevBtn.addEventListener("click", () => void this.navFile(-1));
    this.nextBtn = document.createElement("button");
    this.nextBtn.textContent = "下一章 ›";
    this.nextBtn.addEventListener("click", () => void this.navFile(1));
    this.titleEl = document.createElement("span");
    this.titleEl.className = "rbepub-title";
    bar.append(btnToc, this.prevBtn, this.titleEl, this.nextBtn);

    this.tocPanel = document.createElement("div");
    this.tocPanel.className = "rbepub-toc hidden";
    for (const t of this.book.toc) {
      const row = document.createElement("button");
      row.className = "rbepub-toc-row";
      row.style.paddingLeft = `${8 + t.depth * 14}px`;
      row.textContent = t.label;
      row.addEventListener("click", () => {
        const idx = this.book.spine.indexOf(t.href);
        if (idx < 0) {
          this.ctx.toast("目录指向的内容不在书内");
          return;
        }
        this.tocPanel.classList.add("hidden");
        this.restoreRatio = 0; // 目录跳转从章首开始
        void this.renderSpine(idx, t.anchor);
      });
      this.tocPanel.appendChild(row);
    }

    this.scroll = document.createElement("div");
    this.scroll.className = "rbepub-scroll";
    this.scroll.tabIndex = 0;
    this.mount = document.createElement("div");
    this.mount.className = "rbepub-content";
    this.scroll.appendChild(this.mount);
    this.scroll.addEventListener("scroll", () => this.scheduleSave(), { passive: true });
    this.scroll.addEventListener("keydown", (e) => this.onKey(e));
    // 链接拦截：单次挂载在滚动容器上，composedPath 穿透 shadow root（书籍样式模式）
    this.scroll.addEventListener("click", (e) => this.onContentClick(e));
    host.append(style, bar, this.tocPanel, this.scroll);
  }

  /** 渲染第 i 章（anchor 定位优先，其次 restoreRatio 恢复） */
  private async renderSpine(i: number, anchor = ""): Promise<void> {
    this.saveProgress(); // 切章前保存旧章滚动比（ready=false 时自动跳过）
    this.spineIdx = i;
    const href = this.book.spine[i];
    this.chapterTitle = this.tocLabelFor(href) || baseOf(href);
    const ratio = this.restoreRatio;
    this.restoreRatio = null;

    // 章内容：XHTML → 净化 → 资源改写 → 挂载
    const text = this.readEntryText(href);
    const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
    const bodySrc = doc.querySelector("parsererror") ? null : doc.body;
    this.revokeBlobs();
    this.mount.textContent = ""; // 清空同时移除旧 shadow root
    this.shadow = null;
    if (!bodySrc) {
      this.mount.innerHTML = '<div class="rbepub-empty">本章内容解析失败</div>';
    } else {
      const frag = document.importNode(bodySrc, true);
      sanitizeTree(frag);
      await this.rewriteAssets(frag, href);
      this.interceptLinks(frag, href);
      if (this.mode === "theme") {
        this.mount.append(...frag.childNodes);
      } else {
        // 书籍样式模式：Shadow DOM 隔离，书内 CSS 原样注入
        this.shadow = this.mount.attachShadow({ mode: "open" });
        const st = document.createElement("style");
        st.textContent = this.book.cssText;
        const inner = document.createElement("div");
        inner.className = "rbepub-content";
        inner.append(...frag.childNodes);
        this.shadow.append(st, inner);
      }
    }

    // 定位：锚点优先，其次恢复滚动比（等一帧布局完成）
    const anchorSel = anchor ? `#${CSS.escape(anchor)}` : "";
    window.setTimeout(() => {
      if (anchorSel) {
        const el =
          (this.mount.querySelector(anchorSel) as HTMLElement | null) ||
          (this.shadow?.querySelector(anchorSel) as HTMLElement | null);
        if (el) el.scrollIntoView({ block: "start" });
        else this.scroll.scrollTop = 0;
      } else if (ratio && ratio > 0) {
        const max = this.scroll.scrollHeight - this.scroll.clientHeight;
        if (max > 0) this.scroll.scrollTop = ratio * max;
      } else {
        this.scroll.scrollTop = 0;
      }
    }, 30);

    this.prevBtn.disabled = i === 0;
    this.nextBtn.disabled = i === this.book.spine.length - 1;
    this.titleEl.textContent = this.chapterTitle;
    [...this.tocPanel.children].forEach((row, k) =>
      (row as HTMLElement).classList.toggle("active", this.book.toc[k]?.href === href)
    );
    this.applyTheme();
    this.syncStatus();
    this.ready = true;
    void this.prefetch(i + 1);
  }

  /** 图片转 blob URL（svg image 同时写 href） */
  private async rewriteAssets(frag: DocumentFragment, chapterHref: string): Promise<void> {
    const dir = chapterHref.includes("/") ? chapterHref.slice(0, chapterHref.lastIndexOf("/")) : "";
    for (const el of [...frag.querySelectorAll("img, image")]) {
      const raw = el.getAttribute("src") || el.getAttribute("xlink:href") || el.getAttribute("href") || "";
      if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
      const target = resolveZip(dir, raw);
      try {
        const bytes = this.readEntry(target);
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(target) }));
        this.blobUrls.push(url);
        el.setAttribute("src", url);
        el.setAttribute("href", url); // svg <image> 走 href
      } catch {
        el.remove();
      }
    }
  }

  /** 链接改写为 data 标记（点击统一由 onContentClick 处理） */
  private interceptLinks(frag: DocumentFragment, chapterHref: string): void {
    const dir = chapterHref.includes("/") ? chapterHref.slice(0, chapterHref.lastIndexOf("/")) : "";
    for (const a of [...frag.querySelectorAll("a[href]")]) {
      const raw = a.getAttribute("href") || "";
      if (!raw || /^(https?:|data:|mailto:)/i.test(raw)) continue;
      const si = raw.indexOf("#");
      const anchor = si >= 0 ? raw.slice(si + 1) : "";
      const pathPart = resolveZip(dir, si >= 0 ? raw.slice(0, si) : raw);
      if (pathPart === chapterHref) a.dataset.rbAnchor = anchor;
      else a.dataset.rbJump = `${pathPart}#${anchor}`;
      a.setAttribute("href", "#");
    }
  }

  /** 点击分派：同章锚点滚动 / 跨章跳转（composedPath 穿透 shadow） */
  private onContentClick(e: Event): void {
    const path = e.composedPath() as EventTarget[];
    const target = path[0] as HTMLElement | undefined;
    const a = target?.closest?.("a") as HTMLAnchorElement | null;
    if (!a) return;
    if (a.dataset.rbAnchor !== undefined) {
      e.preventDefault();
      this.scrollToAnchor(a.dataset.rbAnchor);
    } else if (a.dataset.rbJump !== undefined) {
      e.preventDefault();
      const si = a.dataset.rbJump.indexOf("#");
      const p = si >= 0 ? a.dataset.rbJump.slice(0, si) : a.dataset.rbJump;
      const anchor = si >= 0 ? a.dataset.rbJump.slice(si + 1) : "";
      const idx = this.book.spine.indexOf(p);
      if (idx < 0) this.ctx.toast("链接指向的内容不在书内");
      else {
        this.restoreRatio = 0;
        void this.renderSpine(idx, anchor);
      }
    }
  }

  private scrollToAnchor(anchor: string): void {
    if (!anchor) {
      this.scroll.scrollTop = 0;
      return;
    }
    const sel = `#${CSS.escape(anchor)}`;
    const el =
      (this.mount.querySelector(sel) as HTMLElement | null) ||
      (this.shadow?.querySelector(sel) as HTMLElement | null);
    if (el) el.scrollIntoView({ block: "start" });
    else this.scroll.scrollTop = 0;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      this.scroll.scrollBy(0, (e.key === "PageDown" ? 1 : -1) * this.scroll.clientHeight * 0.9);
    } else if (e.key === "ArrowRight") {
      void this.navFile(1);
    } else if (e.key === "ArrowLeft") {
      void this.navFile(-1);
    }
  }

  async navFile(delta: number): Promise<void> {
    const ni = this.spineIdx + delta;
    if (ni < 0 || ni >= this.book.spine.length) {
      this.ctx.toast(delta < 0 ? "已是第一章" : "已是最后一章");
      return;
    }
    await this.renderSpine(ni);
  }

  /* ========== 进度记忆 ========== */

  private posMap(): Record<string, SavedPos> {
    try {
      return JSON.parse(this.ctx.getSetting("positions", "{}")) as Record<string, SavedPos>;
    } catch {
      return {};
    }
  }

  private readPos(): SavedPos | null {
    return this.posMap()[this.ctx.path] || null;
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveProgress(), 2000);
  }

  private saveProgress(): void {
    if (!this.ready) return; // 首章挂载完成前不写（防覆盖待恢复的存档）
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const r = max > 0 ? Math.min(1, this.scroll.scrollTop / max) : 0;
    const map = this.posMap();
    map[this.ctx.path] = { i: this.spineIdx, r, t: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > POS_LIMIT) {
      keys.sort((a, b) => map[a].t - map[b].t);
      for (const k of keys.slice(0, keys.length - POS_LIMIT)) delete map[k];
    }
    this.ctx.setSetting("positions", JSON.stringify(map));
  }

  /** 清除本书进度（公开：插件菜单模块层回调触达实例） */
  clearProgress(): void {
    const map = this.posMap();
    delete map[this.ctx.path];
    this.ctx.setSetting("positions", JSON.stringify(map));
    this.ctx.toast("已清除本书进度");
  }

  /* ========== 渲染模式 / 主题 / 状态 ========== */

  /** 切换渲染模式（公开：插件菜单模块层回调触达实例）；保持当前滚动比 */
  setMode(mode: "theme" | "book"): void {
    this.mode = prefMode = mode;
    this.ctx.setSetting("styleMode", mode);
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    this.restoreRatio = max > 0 ? this.scroll.scrollTop / max : 0;
    void this.renderSpine(this.spineIdx);
  }

  private applyTheme(): void {
    if (this.mode !== "theme") return;
    const t = readTheme();
    this.scroll.style.background = t.bg;
    this.mount.style.color = t.text;
    this.mount.style.fontFamily = t.fontFamily;
    this.mount.style.fontSize = t.fontSize;
    this.mount.style.lineHeight = t.lineHeight;
  }

  private tocLabelFor(href: string): string {
    return this.book.toc.find((t) => t.href === href)?.label || "";
  }

  private syncStatus(): void {
    const max = this.scroll.scrollHeight - this.scroll.clientHeight;
    const pct = max > 0 ? Math.min(100, Math.round((this.scroll.scrollTop / max) * 100)) : 100;
    this.ctx.setStatus({
      title: this.ctx.name,
      file: this.chapterTitle,
      position: `第 ${this.spineIdx + 1}/${this.book.spine.length} 章 · ${pct}%`,
      encoding: `EPUB ${this.book.version}`,
      mode: `模式: ${this.mode === "theme" ? "跟随主题" : "书籍样式"}`,
      display: "-",
    });
  }

  /* ========== 条目读取（LRU 缓存 + 预取） ========== */

  private readEntry(name: string): Uint8Array {
    const hit = this.lru.get(name);
    if (hit) {
      this.lru.delete(name);
      this.lru.set(name, hit);
      return hit;
    }
    const bytes = this.zip.read(name);
    this.lru.set(name, bytes);
    if (this.lru.size > 32) this.lru.delete(this.lru.keys().next().value as string);
    return bytes;
  }

  private readEntryText(name: string): string {
    const hit = this.lru.get(name);
    if (hit) return decodeXml(hit);
    const text = this.zip.readText(name);
    // 顺带入缓存
    const bytes = this.lru.get(name) ?? this.zip.read(name);
    this.lru.set(name, bytes);
    if (this.lru.size > 32) this.lru.delete(this.lru.keys().next().value as string);
    return text;
  }

  private prefetch(i: number): void {
    if (i >= this.book.spine.length || this.lru.has(this.book.spine[i])) return;
    try {
      this.readEntry(this.book.spine[i]);
    } catch {
      /* 预取失败不阻塞 */
    }
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  deactivate(): void {
    this.saveProgress();
    openViews.delete(this);
    this.unwatch?.();
    window.clearTimeout(this.saveTimer);
    this.revokeBlobs();
  }

  private revokeBlobs(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
  }
}

/** zip 内相对路径解析（无复合前缀，段式） */
function resolveZip(dir: string, rel: string): string {
  let r = rel;
  try {
    r = decodeURIComponent(rel);
  } catch {
    /* 保持原样 */
  }
  const segs = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of r.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

function mimeOf(path: string): string {
  const e = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  if (e === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

const plugin: Read4EverPlugin = {
  id: PID,
  name: "EPUB 查看",
  version: "1.0.0",
  description: "EPUB 阅读：目录导航、进度记忆、跟随主题/书籍样式双模式",
  extensions: [".epub"],
  createView: () => new EpubView(),
  menu: (): MenuItemDef[] => [
    {
      label: "跟随阅读主题",
      checked: () => prefMode === "theme",
      action: () => openViews.forEach((v) => v.setMode("theme")),
    },
    {
      label: "书籍自带样式",
      checked: () => prefMode === "book",
      action: () => openViews.forEach((v) => v.setMode("book")),
    },
    { sep: true },
    { label: "清除本书进度", action: () => openViews.forEach((v) => v.clearProgress()) },
  ],
};

export default plugin;
```

- [ ] **Step 2: 构建**

```bash
npm run build:plugins
```

Expected: 两插件产物均生成，tsc 零报错。

- [ ] **Step 3: 浏览器验证**

```bash
npm run dev
```

1. 插件管理出现「EPUB 查看」（外部、启用）。
2. 双击 `演示之书.epub`：渲染第一章（跟随主题字体配色），ch1 图片显示，状态栏 `第 1/3 章 · …`、`EPUB 3`、模式「跟随主题」。
3. ☰ 目录 → 点「第二章 旧城的钥匙」跳章；ch2 内链接「第三章」跨章跳转、「那张字条」同章锚点回跳。
4. `Ctrl+PgDn` 下一章 / `‹ ›` 按钮 / 聚焦内容区后 `←→` 键；首末章按钮禁用并有 toast。
5. 第二章滚到中部 → Esc 关闭 → 重开：toast「已续读上次位置」且位置恢复。
6. 插件菜单 → 书籍自带样式：`h2` 变酒红衬线、段落 2em 缩进（style.css 生效）；切回跟随主题恢复；切换时保持当前滚动位置。
7. 跟随主题模式下切外观主题实时跟随；两个标签页各开一个 epub 视图互不干扰；DevTools 控制台无报错。

- [ ] **Step 4: 提交**

```bash
git add plugins-dev/epub-viewer
git commit -m "新增 epub-viewer 外部插件（双渲染模式/目录导航/进度记忆）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 真机验证与文档收尾

**Files:**
- Modify: `README.md`（插件系统行 + 目录结构）
- Modify: `docs/spec/插件开发.md`（参考实现一节）

- [ ] **Step 1: 全量构建验证**

```bash
npm run build && npm run build:plugins
```

Expected: 全绿；记录产物大小 `ls -la plugins-dev/*/dist/*.rbplugin`（预期 markdown ~50KB、epub ~80KB 内）。

- [ ] **Step 2: 真机安装验证（需 Rust 工具链）**

```bash
npm run tauri dev
```

1. 工具 → 插件管理 → 📦 安装插件… → 选 `plugins-dev/markdown-viewer/dist/markdown-viewer.rbplugin`；同法装 epub-viewer。面板出现两行「外部」徽标。
2. 打开对话框（Ctrl+O）：过滤器出现 `.md/.markdown/.mdown/.epub`。
3. 打开真实 `.md`/`.epub` 验证（无真实 epub 时把 mock 演示书字节落盘为 `.epub`：浏览器 console 里对 `read_file_bytes("C:\demo\书库\演示之书.epub")` 结果 base64 落盘即可）；重点测 EPUB2/NCX 老书与体量大的书。
4. zip 内嵌验证：把 `.md`/`.epub` 塞进一个 `.zip`，打开 zip → 打开内嵌条目（走 `xxx.zip::a.md` 复合路径，epub 插件拿到的 bytes 即整本 epub，自解压不受影响）。
5. 卸载一个插件 → 面板消失、相关扩展名不可再打开；重装恢复（覆盖安装）。
6. `Ctrl+W` 关标签页、多标签页各开一种视图、Esc 关闭——生命周期无残留报错（DevTools 控制台干净）。

- [ ] **Step 3: README 更新**

功能表「插件系统」行，在「外部插件为 `.rbplugin` 包…开发接口见 [docs/插件开发.md](docs/插件开发.md)）」的右括号后、「；插件视图激活时…」之前插入：

> ；仓库附带两个外部插件源码于 `plugins-dev/`——Markdown 查看（渲染/源码切换、大纲面板、上一份/下一份接续、跟随阅读主题）与 EPUB 查看（EPUB3/2 目录导航、章节接续、进度记忆、跟随主题/书籍样式双模式），`npm run build:plugins` 构建出 `.rbplugin` 后在插件管理中安装

目录结构树（`│   └── 插件开发.md` 所在 docs 子树旁、与 `src` 平级处）加一行：

```
├── plugins-dev/             # 外部插件源码（_shared 公共模块 + markdown-viewer + epub-viewer，构建出 .rbplugin）
```

（按现有树的画法对齐即可；src 子树不必展开 plugins-dev 细节。）

- [ ] **Step 4: 插件开发.md 增补**

「安全模型（当前版本）」一节之前插入：

```markdown
## 参考实现

仓库 `plugins-dev/` 附带两个完整外部插件（`npm run build:plugins` 构建出 `.rbplugin`）：

- **markdown-viewer**：marked 打包、轻量净化、大纲面板、siblings 接续（上一份/下一份）、渲染/源码切换。
- **epub-viewer**：自写 zip 中央目录解析 + fflate 按需解压、OPF/目录解析（EPUB3 nav，NCX 回退）、双渲染模式（跟随主题内联 DOM / 书籍样式 Shadow DOM）、按书路径进度记忆。

### 主题跟随技巧

外部插件拿不到宿主 `themes` 模块，但可以：颜色读根元素 CSS 变量（`--reader-bg`/`--reader-text`/`--ui-*`/`--accent`，`applyTheme` 每次换主题都会更新）；字体/字号/行距读 `#reader-content` 的计算样式（宿主直写内联样式）；再用 `MutationObserver` 监听 `document.documentElement` 与 `#reader-content` 的 `style` 属性变化即可实时跟随——见 `plugins-dev/_shared/theme.ts`。
```

- [ ] **Step 5: 提交**

```bash
git add README.md docs/spec/插件开发.md
git commit -m "文档：外部插件参考实现与 build:plugins 说明

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 验收对照（spec → 任务）

| spec 条目 | 任务 |
|---|---|
| 构建设施/目录结构/类型检查 | Task 1、3 |
| mock 演示书 + dev 直读 | Task 2 |
| markdown 渲染/净化/编码/图片 | Task 4 |
| markdown 大纲/接续/源码切换/状态栏 | Task 4 |
| epub zip 解析（含 ZIP64、64MB 上限） | Task 5 |
| epub OPF/spine/TOC（EPUB3+NCX 回退） | Task 5 |
| epub 双渲染模式/目录/章节导航/进度记忆 | Task 6 |
| 浏览器与真机验证（含 zip 内嵌、安装卸载） | Task 2/4/6/7 |
| README 与插件开发.md 同步 | Task 7 |
