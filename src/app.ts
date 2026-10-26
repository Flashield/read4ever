/* 主应用状态与动作 */
import { api } from "./api";
import * as reader from "./reader";
import * as plugins from "./plugins/registry";
import { applyTheme, findThemeByName, normalizeFontFamily, FONT_SONG } from "./themes";
import { convertDisplay, type DisplayMode } from "./simp_trad";
import { showDropdown, initDropdown } from "./dropdown";
import type { FileContent, StoreData } from "./types";

export const state = {
  store: null as unknown as StoreData,
  filePath: "", // 后端返回的 filePath（zip 形式为 zip::entry）
  realPath: "", // 文件系统路径（zip 条目则为 zip 自身路径）
  zipEntry: "",
  isZip: false,
  fileName: "",
  raw: "", // 打开时解码得到的原文
  encoding: "",
  modified: false,
  isHardLines: false,
  displayMode: "auto" as DisplayMode,
  prevPositions: [] as number[], // Ctrl+Z 回退栈
  readSeconds: 0,
};

export function defaultStore(): StoreData {
  return {
    settings: {
      themeName: "白纸",
      customThemes: [],
      customBg: "#ffffff",
      customText: "#000000",
      fontFamily: FONT_SONG,
      fontSize: 18,
      lineSpacing: 1.8,
      scrollSpeed: 3,
      scrollMode: "continuous",
      pageInterval: 10,
      displayMode: "auto",
      dualPage: false,
      lastFilePath: "",
      lastScroll: 0,
      autoRestore: true,
      activeKeywordGroupId: "",
      lastFolderPath: "",
      folderAutoOpen: true,
      folderListRecursive: false,
      plugins: {},
      pluginSettings: {},
    },
    bookmarks: [],
    history: [],
    bookshelf: [],
    keywordGroups: [],
  };
}

/* 补齐缺失字段（旧版本配置兼容），并把旧配置里的裸 Windows 字体名换成跨平台字体栈 */
function mergeDefaults(data: StoreData): StoreData {
  const def = defaultStore();
  const merged: StoreData = { ...def, ...data, settings: { ...def.settings, ...data.settings } };
  merged.settings.fontFamily = normalizeFontFamily(merged.settings.fontFamily);
  merged.settings.customThemes = (merged.settings.customThemes || []).map((t) => ({
    ...t,
    fontFamily: normalizeFontFamily(t.fontFamily),
  }));
  return merged;
}

/* ========== 持久化 ========== */

let persistTimer = 0;
export function persist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    api.saveStore(state.store).catch(() => {});
  }, 400);
}

export function persistNow(): void {
  window.clearTimeout(persistTimer);
  api.saveStore(state.store).catch(() => {});
}

/* ========== 外观 ========== */

export function applyAppearance(): void {
  const s = state.store.settings;
  const t = findThemeByName(s.themeName, s.customThemes);
  if (t) {
    // 字体三要素以设置为准（用户可单独调整）
    applyTheme({ ...t, fontFamily: s.fontFamily, fontSize: s.fontSize, lineSpacing: s.lineSpacing });
  } else if (s.themeName === "自定义") {
    // 尚未保存为方案的自定义配色：沿用最近一次选择的背景/文字颜色
    applyTheme({
      name: s.themeName,
      bg: s.customBg || "#ffffff",
      text: s.customText || "#000000",
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineSpacing: s.lineSpacing,
    });
  } else {
    applyTheme({ name: s.themeName, bg: "#ffffff", text: "#000000", fontFamily: s.fontFamily, fontSize: s.fontSize, lineSpacing: s.lineSpacing });
  }
  document.dispatchEvent(new CustomEvent("rb-theme-changed"));
}

export function applyThemeByName(name: string): void {
  const s = state.store.settings;
  const t = findThemeByName(name, s.customThemes);
  if (!t) return;
  s.themeName = name;
  s.fontFamily = t.fontFamily;
  s.fontSize = t.fontSize;
  s.lineSpacing = t.lineSpacing;
  applyAppearance();
  persist();
}

export function applyCustomLook(bg: string, text: string): void {
  const s = state.store.settings;
  s.themeName = "自定义";
  s.customBg = bg;
  s.customText = text;
  applyTheme({ name: "自定义", bg, text, fontFamily: s.fontFamily, fontSize: s.fontSize, lineSpacing: s.lineSpacing });
  persist();
}

/* ========== 显示（简繁转换） ========== */

/* 网文/电子书常残留未解码的 HTML 实体（&quot; 等），打开时统一还原为字符 */
const HTML_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  divide: "÷",
  copy: "©",
  reg: "®",
  trade: "™",
};

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/** 单遍解码：&amp; 与其他实体同轮替换，不会二次解码（&amp;quot; 还原为字面 &quot;） */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_RE, (whole, hex, dec, name) => {
    if (hex || dec) {
      const cp = parseInt(hex ? hex : dec, hex ? 16 : 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    const mapped = HTML_ENTITIES[name.toLowerCase()];
    return mapped !== undefined ? mapped : whole; // 未知实体原样保留
  });
}

export function currentDisplayText(): string {
  return convertDisplay(state.raw, state.displayMode);
}

export function renderContent(keepRatio?: number): void {
  const r = keepRatio !== undefined ? keepRatio : reader.getRatio();
  reader.setContent(currentDisplayText());
  if (r > 0) reader.setRatio(r);
}

/* 内容重渲染后通知依赖当前文本的模块（如关键词检索）重建索引 */
function notifyContentChanged(): void {
  document.dispatchEvent(new CustomEvent("rb-content-changed"));
}

export function setDisplayMode(m: DisplayMode): void {
  state.displayMode = m;
  state.store.settings.displayMode = m;
  renderContent();
  updateUI();
  persist();
  notifyContentChanged();
}

export function cycleDisplayMode(): void {
  const order: DisplayMode[] = ["auto", "simplified", "traditional"];
  const idx = order.indexOf(state.displayMode);
  setDisplayMode(order[(idx + 1) % order.length]);
  toast(`显示: ${displayModeLabel()}`);
}

export function displayModeLabel(): string {
  return state.displayMode === "auto" ? "原码" : state.displayMode === "simplified" ? "简体" : "繁体";
}

/* ========== 位置栈 ========== */

export function pushPosition(): void {
  state.prevPositions.push(reader.getRatio());
  if (state.prevPositions.length > 50) state.prevPositions.shift();
}

export function goBack(): void {
  const r = state.prevPositions.pop();
  if (r === undefined) {
    toast("没有更早的位置");
    return;
  }
  reader.setRatio(r);
  updateStatus();
}

export function jumpToRatio(r: number): void {
  pushPosition();
  reader.setRatio(r);
  updateStatus();
}

/* ========== 打开文件 ========== */

export interface OpenOpts {
  ratio?: number;
  restoreFromHistory?: boolean;
  /** 手动指定编码重新打开（自动检测误判时的兜底） */
  encoding?: string;
  /** 启动自动恢复等场景：失败只轻提示，不弹错误对话框 */
  quiet?: boolean;
}

/** zip 条目在历史/书签/设置里保存为「zip路径::条目名」的复合路径 */
const ZIP_COMBINED_RE = /^(.+\.zip)::(.+)$/i;

export async function openPath(path: string, opts: OpenOpts = {}): Promise<void> {
  if (!path) return;
  reader.stopScroll();
  saveCurrentProgress();
  try {
    const zm = path.match(ZIP_COMBINED_RE);
    if (zm) {
      // 条目扩展名命中启用插件（如图片）→ 插件接管
      if (plugins.handlerForExt(plugins.extOf(zm[2]))) {
        await plugins.openFile(path);
        return;
      }
      await openZipEntry(zm[1], zm[2], opts);
      return;
    }
    if (path.toLowerCase().endsWith(".zip")) {
      const entries = await api.listZip(path);
      // 只列出当前可打开的条目：TXT 恒可；其余取决于启用的插件
      const openable = entries.filter(
        (n) => /\.(txt|zip)$/i.test(n) || plugins.handlerForExt(plugins.extOf(n))
      );
      if (openable.length === 0) {
        showMessage("提示", "该 ZIP 压缩包中没有找到可打开的文件。");
        return;
      }
      if (openable.length === 1) {
        await openPath(`${path}::${openable[0]}`, opts);
        return;
      }
      // 多个条目：弹出选择菜单
      const rect = (document.getElementById("reader-container") as HTMLElement).getBoundingClientRect();
      showDropdown(
        [
          { label: `选择要阅读的文件（共 ${openable.length} 个）：`, disabled: true },
          { sep: true },
          ...openable.map((entry) => ({
            label: entry,
            action: () => openPath(`${path}::${entry}`, opts),
          })),
        ],
        rect.left + rect.width / 2 - 150,
        rect.top + 40
      );
      return;
    }
    if (plugins.handlerForExt(plugins.extOf(path))) {
      await plugins.openFile(path);
      return;
    }
    const fc = await api.openText(path, opts.encoding);
    loadFileContent(fc, { isZip: false, zipPath: "", zipEntry: "" }, opts);
  } catch (e) {
    if (opts.quiet) {
      toast(`未能恢复上次阅读：${String(e).slice(0, 60)}`);
    } else {
      showMessage("打开失败", String(e));
    }
  }
}

export async function openZipEntry(
  zipPath: string,
  entry: string,
  opts: OpenOpts = {}
): Promise<void> {
  try {
    const fc = await api.readZip(zipPath, entry, opts.encoding);
    loadFileContent(fc, { isZip: true, zipPath, zipEntry: entry }, opts);
  } catch (e) {
    if (opts.quiet) {
      toast(`未能恢复上次阅读：${String(e).slice(0, 60)}`);
    } else {
      showMessage("打开失败", String(e));
    }
  }
}

export async function openFileDialog(): Promise<void> {
  // 打开对话框的过滤器随启用的插件动态扩展（如图片格式）
  const p = await api.pickOpenFile(plugins.pluginExts());
  if (p) openPath(p);
}

function loadFileContent(
  fc: FileContent,
  src: { isZip: boolean; zipPath: string; zipEntry: string },
  opts: OpenOpts
): void {
  plugins.deactivateActive(); // 若当前显示插件视图（如图片），先退回文本渲染
  state.filePath = fc.filePath;
  state.realPath = src.isZip ? src.zipPath : fc.filePath;
  state.zipEntry = src.zipEntry;
  state.isZip = src.isZip;
  state.fileName = src.isZip ? src.zipEntry.split("/").pop() || src.zipEntry : fc.fileName;
  state.raw = decodeHtmlEntities(fc.content);
  state.encoding = fc.encoding;
  state.modified = false;
  state.isHardLines = fc.isHardLines;
  state.prevPositions = [];
  state.readSeconds = 0;

  // 恢复位置：显式指定 > 历史记录
  let ratio = opts.ratio;
  if (ratio === undefined) {
    const h = state.store.history.find((x) => x.filePath === fc.filePath);
    if (h && h.position > 0.001 && h.position < 0.999) {
      ratio = h.position;
      toast("已恢复到上次阅读位置");
    }
  }
  renderContent(ratio ?? 0);
  upsertHistory(fc.filePath, state.fileName, fc.encoding, ratio ?? 0);
  state.store.settings.lastFilePath = fc.filePath;
  state.store.settings.lastScroll = ratio ?? 0;
  (document.getElementById("reader-content") as HTMLElement).focus();
  updateUI();
  persist();
  notifyContentChanged();
}

/* 按序号打开上一个/下一个文件 */
export async function gotoNextFile(): Promise<void> {
  if (!state.realPath) return;
  const n = await api.nextFile(state.realPath);
  if (n) openPath(n);
  else toast("没有下一个文件");
}

export async function gotoPrevFile(): Promise<void> {
  if (!state.realPath) return;
  const p = await api.prevFile(state.realPath);
  if (p) openPath(p);
  else toast("没有上一个文件");
}

/* ========== 阅读进度记录 ========== */

function upsertHistory(filePath: string, fileName: string, encoding: string, position: number): void {
  const list = state.store.history;
  const now = new Date().toISOString();
  const existing = list.find((x) => x.filePath === filePath);
  if (existing) {
    state.readSeconds = existing.readSeconds;
    existing.lastRead = now;
    existing.position = position;
    existing.encoding = encoding;
    list.splice(list.indexOf(existing), 1);
    list.unshift(existing);
  } else {
    state.readSeconds = 0;
    list.unshift({ filePath, fileName, position, encoding, lastRead: now, readSeconds: 0 });
  }
  if (list.length > 100) list.length = 100;
}

/* 切换文件前保存当前进度 */
function saveCurrentProgress(): void {
  if (!state.filePath) return;
  const pos = reader.getRatio();
  const h = state.store.history.find((x) => x.filePath === state.filePath);
  if (h) h.position = pos;
  state.store.settings.lastFilePath = state.filePath;
  state.store.settings.lastScroll = pos;
  persist();
}

let progressRaf = 0;
function onReaderProgress(): void {
  if (progressRaf) return;
  progressRaf = requestAnimationFrame(() => {
    progressRaf = 0;
    updateStatus();
    if (!state.filePath) return;
    const pos = reader.getRatio();
    state.store.settings.lastFilePath = state.filePath;
    state.store.settings.lastScroll = pos;
    const h = state.store.history.find((x) => x.filePath === state.filePath);
    if (h) h.position = pos;
    persist();
  });
}

function onPageEnd(): void {
  toast("已到达文末");
}

/* 阅读时长计时（每秒） */
function startReadTicker(): void {
  window.setInterval(() => {
    if (!state.filePath || document.hidden) return;
    state.readSeconds++;
    const h = state.store.history.find((x) => x.filePath === state.filePath);
    if (h) h.readSeconds = state.readSeconds;
    if (state.readSeconds % 15 === 0) persist();
  }, 1000);
}

/* ========== 滚屏 ========== */

export function toggleScroll(): void {
  if (!state.filePath) return;
  const on = reader.toggleScroll();
  if (on)
    toast(
      `开始${reader.getMode() === "page" ? "页模式翻页" : "滚屏"}（当前 ${reader.getSpeed()} 档 ≈ ${reader.speedPx()} 像素/秒，鼠标上下移动可调速）`
    );
  updateUI();
}

export function setScrollMode(m: reader.ScrollMode): void {
  reader.setMode(m);
  state.store.settings.scrollMode = m;
  persist();
  updateUI();
  toast(m === "page" ? "页模式翻页" : "连续滚屏");
}

export function toggleScrollMode(): void {
  setScrollMode(reader.getMode() === "page" ? "continuous" : "page");
}

function emitSpeedChanged(): void {
  document.dispatchEvent(new CustomEvent("rb-speed-changed"));
}

export function adjustSpeed(d: number): void {
  reader.adjustSpeed(d);
  state.store.settings.scrollSpeed = reader.getSpeed();
  persist();
  updateUI();
  emitSpeedChanged();
}

export function setSpeed(n: number): void {
  reader.setSpeed(n);
  state.store.settings.scrollSpeed = reader.getSpeed();
  persist();
  updateUI();
  emitSpeedChanged();
}

/* ========== 滚屏速度选择（具体数值） ========== */

export function showSpeedPicker(): void {
  const rect = document.getElementById("speed-label")?.getBoundingClientRect();
  const x = rect ? rect.left : window.innerWidth / 2 - 120;
  const y = rect ? rect.bottom + 4 : 60;

  const row = document.createElement("div");
  row.className = "speed-picker";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "1";
  slider.max = "9";
  slider.step = "0.5";
  slider.value = String(reader.getSpeed());
  const val = document.createElement("span");
  val.className = "speed-picker-value";
  const sync = () => {
    slider.value = String(reader.getSpeed());
    val.textContent = `${reader.getSpeed()} 档 ≈ ${reader.speedPx()} 像素/秒`;
  };
  sync();
  slider.addEventListener("input", () => setSpeed(Number(slider.value)));
  row.appendChild(slider);
  row.appendChild(val);

  const onSpeedChanged = () => sync();
  document.addEventListener("rb-speed-changed", onSpeedChanged);

  showDropdown(
    [
      { label: "滚屏速度（鼠标上下位置仍可临时调速）", disabled: true },
      { customEl: row },
      { sep: true },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
        label: `${n} 档 · 约 ${n * 45} 像素/秒`,
        checked: () => reader.getSpeed() === n,
        action: () => setSpeed(n),
      })),
    ],
    x,
    y,
    () => document.removeEventListener("rb-speed-changed", onSpeedChanged)
  );
}

/* ========== 书签 ========== */

export function addBookmark(desc?: string): void {
  if (!state.filePath) return;
  const pos = reader.getRatio();
  const text = currentDisplayText();
  const snippet =
    desc ||
    text.slice(Math.floor(pos * text.length), Math.floor(pos * text.length) + 30).replace(/\s+/g, " ").trim() ||
    state.fileName;
  state.store.bookmarks.unshift({
    filePath: state.filePath,
    position: pos,
    description: snippet,
    created: new Date().toISOString(),
  });
  if (state.store.bookmarks.length > 200) state.store.bookmarks.length = 200;
  persist();
  toast("已添加书签（工具栏 📑 或「阅读 → 书签列表」查看）");
  document.dispatchEvent(new CustomEvent("rb-store-changed"));
}

export function jumpBookmark(filePath: string, position: number): void {
  if (filePath === state.filePath) {
    jumpToRatio(position);
  } else {
    openPath(filePath, { ratio: position });
  }
}

export function deleteBookmarkAt(idx: number): void {
  state.store.bookmarks.splice(idx, 1);
  persist();
  document.dispatchEvent(new CustomEvent("rb-store-changed"));
}

/* ========== 收藏书架 ========== */

export function addToBookshelf(name?: string): void {
  if (!state.filePath) return;
  if (state.store.bookshelf.some((b) => b.filePath === state.filePath)) {
    toast("已在书架中");
    return;
  }
  state.store.bookshelf.unshift({
    filePath: state.filePath,
    name: name || state.fileName.replace(/\.txt$/i, ""),
    added: new Date().toISOString(),
  });
  persist();
  toast("已加入收藏书架");
  document.dispatchEvent(new CustomEvent("rb-store-changed"));
}

export function deleteBookshelfAt(idx: number): void {
  state.store.bookshelf.splice(idx, 1);
  persist();
  document.dispatchEvent(new CustomEvent("rb-store-changed"));
}

/* ========== 历史 ========== */

export function clearHistory(): void {
  state.store.history = [];
  persist();
  document.dispatchEvent(new CustomEvent("rb-store-changed"));
  toast("已清除历史记录");
}

export function deleteHistoryAt(idx: number): void {
  state.store.history.splice(idx, 1);
  persist();
  document.dispatchEvent(new CustomEvent("rb-store-changed"));
}

/* ========== 重新排版 ========== */

export async function doReorder(): Promise<void> {
  if (!state.filePath) return;
  const newText = await api.reorder(state.raw);
  if (newText === state.raw) {
    toast("排版无需调整");
    return;
  }
  pushPosition();
  state.raw = newText;
  state.modified = true;
  state.isHardLines = false;
  renderContent();
  updateUI();
  toast("已重新排版，另存为新文件可保留结果");
  notifyContentChanged();
}

/* ========== 另存为 ========== */

const SAVE_ENCODINGS = ["UTF-8", "GB18030", "Big5", "UTF-16LE", "UTF-16BE"];

export function saveAs(): void {
  if (!state.filePath) return;
  showDropdown(
    [{ label: "选择保存编码：", disabled: true }, { sep: true }, ...SAVE_ENCODINGS.map((enc) => ({ label: enc, action: () => pickSaveAs(enc) }))],
    window.innerWidth / 2 - 100,
    window.innerHeight / 2 - 80
  );
}

async function pickSaveAs(encoding: string): Promise<void> {
  const base = state.fileName.replace(/\.txt$/i, "");
  const p = await api.pickSaveFile(`${base}-整理版.txt`);
  if (!p) return;
  try {
    await api.saveText(p, currentDisplayText(), encoding);
    toast(`已保存为 ${encoding} 编码文件`);
  } catch (e) {
    showMessage("保存失败", String(e));
  }
}

/* ========== 以指定编码重新打开 ========== */

const OPEN_ENCODINGS: { label: string; value?: string }[] = [
  { label: "自动检测", value: undefined },
  { label: "UTF-8", value: "UTF-8" },
  { label: "GB18030（简体中文）", value: "GB18030" },
  { label: "Big5（繁体中文）", value: "Big5" },
  { label: "UTF-16LE", value: "UTF-16LE" },
  { label: "UTF-16BE", value: "UTF-16BE" },
];

/** 打开乱码时手动切换编码（状态栏「编码」与工具菜单入口） */
export function pickEncoding(): void {
  if (!state.filePath) return;
  showDropdown(
    [
      { label: "以指定编码重新打开：", disabled: true },
      { sep: true },
      ...OPEN_ENCODINGS.map((e) => ({
        label: e.label,
        action: () => reopenWithEncoding(e.value),
      })),
    ],
    window.innerWidth / 2 - 110,
    window.innerHeight / 2 - 100
  );
}

async function reopenWithEncoding(encoding?: string): Promise<void> {
  const ratio = reader.getRatio();
  if (state.isZip) {
    await openZipEntry(state.realPath, state.zipEntry, { ratio, encoding });
  } else {
    await openPath(state.filePath, { ratio, encoding });
  }
  toast(encoding ? `已按 ${encoding} 重新打开` : "已按自动检测重新打开");
}

function initEncodingSwitcher(): void {
  const el = document.getElementById("status-encoding");
  if (!el) return;
  el.title = "显示乱码？点击选择编码重新打开";
  el.addEventListener("click", () => pickEncoding());
}

/* ========== 局部编辑 ========== */

let editOriginal = "";

export function openEditor(): void {
  if (!state.filePath) return;
  if (state.isZip) {
    toast("ZIP 内文件为只读，请先另存为后再编辑");
    return;
  }
  const sel = window.getSelection()?.toString() ?? "";
  editOriginal = sel;
  const ta = document.getElementById("edit-textarea") as HTMLTextAreaElement;
  ta.value = sel;
  document.getElementById("edit-modal")?.classList.remove("hidden");
  ta.focus();
}

export function closeEditor(): void {
  document.getElementById("edit-modal")?.classList.add("hidden");
}

export async function saveEditor(): Promise<void> {
  const ta = document.getElementById("edit-textarea") as HTMLTextAreaElement;
  const newText = ta.value;
  if (!editOriginal) {
    if (newText) showMessage("提示", "请先在正文中选中一段文字（或双击一个词），再打开局部编辑。");
    closeEditor();
    return;
  }
  if (newText === editOriginal) {
    closeEditor();
    return;
  }
  // 从当前阅读位置附近开始查找原文
  let idx = -1;
  const startOff = Math.floor(reader.getRatio() * state.raw.length);
  idx = state.raw.indexOf(editOriginal, startOff);
  if (idx < 0) idx = state.raw.indexOf(editOriginal);
  if (idx < 0) {
    showMessage("提示", "未能在原文中定位所选文字（简繁转换显示的内容不能直接编辑，请切回原码显示）。");
    return;
  }
  pushPosition();
  state.raw = state.raw.slice(0, idx) + newText + state.raw.slice(idx + editOriginal.length);
  renderContent();
  try {
    await api.editSave(state.realPath, state.raw, state.encoding);
    state.modified = false;
    toast("已修改并保存到原文件");
  } catch (e) {
    state.modified = true;
    showMessage("写回原文件失败（内容已在窗口中修改）", String(e));
  }
  closeEditor();
  updateUI();
  notifyContentChanged();
}

function initEditModal(): void {
  document.getElementById("edit-save-btn")?.addEventListener("click", () => saveEditor());
  document.getElementById("edit-cancel-btn")?.addEventListener("click", closeEditor);
  document.getElementById("edit-close")?.addEventListener("click", closeEditor);
  document.getElementById("edit-modal")?.addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeEditor();
  });
}

/* 双击正文：选中词并打开局部编辑 */
function initDblClickEdit(): void {
  (document.getElementById("reader-content") as HTMLElement).addEventListener("dblclick", () => {
    // 等浏览器完成选词
    window.setTimeout(() => {
      const sel = (window.getSelection()?.toString() ?? "").trim();
      if (sel) openEditor();
    }, 0);
  });
}

/* 阅读区右键菜单（插件视图显示期间不弹出） */
function initReaderContextMenu(): void {
  (document.getElementById("reader-content") as HTMLElement).addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const pluginActive = !document.getElementById("plugin-view-host")?.classList.contains("hidden");
    if (!state.filePath || pluginActive) return;
    showDropdown(
      [
        {
          label: "在文件夹栏中定位当前文件",
          action: () => {
            void import("./folder").then((f) => f.revealFile(state.realPath || state.filePath));
          },
        },
      ],
      e.clientX,
      e.clientY
    );
  });
}

/* ========== 双页 / 全屏 / 托盘 ========== */

let lastSingleRatio = 0; // 切入双页前的单页位置（双页内容不足两列时用于回退）

export function toggleDual(): void {
  const on = !reader.isDual();
  if (on) {
    lastSingleRatio = reader.getRatio();
    reader.setDual(true);
    reader.setRatio(lastSingleRatio);
  } else {
    const r = reader.getRatio();
    reader.setDual(false);
    // 双页里横向比例有效就用它；内容不足两列没有横向滚动时，退回切入前的位置
    reader.setRatio(r > 0 ? r : lastSingleRatio);
  }
  state.store.settings.dualPage = on;
  persist();
  updateUI();
  toast(on ? "双页模式（已保持阅读位置）" : "单页模式（已保持阅读位置）");
}

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

export async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    /* 忽略 */
  }
}

export function hideToTray(): void {
  saveCurrentProgress();
  api.hideToTray();
}

export function exitApp(): void {
  saveCurrentProgress();
  persistNow();
  api.exitApp();
}

/* ========== Esc 分级关闭 ========== */

export function handleEscape(): void {
  const modal = document.getElementById("edit-modal");
  if (modal && !modal.classList.contains("hidden")) {
    closeEditor();
    return;
  }
  document.dispatchEvent(new CustomEvent("rb-escape"));
}

/* ========== UI 更新 ========== */

export function updateUI(): void {
  // 插件视图激活期间：标题与右上角文件名以插件上报为准（未上报则退回文件名）
  const pst = plugins.getActiveStatus();
  if (pst) {
    const title = pst.title ?? plugins.getActiveFile();
    api.setTitle(`ReadBook - ${title || "未打开文件"}`);
    const fileInfo = document.getElementById("file-info");
    if (fileInfo) fileInfo.textContent = title || "未打开文件";
  } else {
    const modifiedMark = state.modified ? " *" : "";
    api.setTitle(`ReadBook - ${state.fileName || "未打开文件"}${modifiedMark}`);
    const fileInfo = document.getElementById("file-info");
    if (fileInfo) fileInfo.textContent = state.fileName ? `${state.fileName}${modifiedMark}` : "未打开文件";
  }
  const speedLabel = document.getElementById("speed-label");
  if (speedLabel) speedLabel.textContent = `速度:${reader.getSpeed()} · ${reader.speedPx()}px/s`;
  const setBtn = (id: string, active: boolean) => {
    const b = document.getElementById(id);
    if (b) b.classList.toggle("active", active);
  };
  setBtn("btn-scroll", reader.isScrolling());
  setBtn("btn-page-mode", reader.getMode() === "page");
  setBtn("btn-dual-page", reader.isDual());
  setBtn("btn-fullscreen", isFullscreen());
  const simpBtn = document.getElementById("btn-simp-trad");
  if (simpBtn) simpBtn.textContent = displayModeLabel().slice(0, 1);
  updateStatus();
}

export function updateStatus(): void {
  // 插件视图激活期间：四格显示插件上报的原文（含其自定义前缀），未上报为 "-"
  const pst = plugins.getActiveStatus();
  const enc = document.getElementById("status-encoding");
  if (enc) enc.textContent = pst ? (pst.encoding ?? "-") : `编码: ${state.encoding || "-"}`;
  const pos = document.getElementById("status-position");
  if (pos) pos.textContent = pst ? (pst.position ?? "-") : `位置: ${Math.round(reader.getRatio() * 100)}%`;
  const mode = document.getElementById("status-mode");
  if (mode) {
    if (pst) {
      mode.textContent = pst.mode ?? "-";
    } else {
      const m = reader.getMode() === "page" ? "页模式" : "连续";
      mode.textContent = `模式: ${reader.isScrolling() ? m + "滚屏中" : m}`;
    }
  }
  const disp = document.getElementById("status-display");
  if (disp) disp.textContent = pst ? (pst.display ?? "-") : `显示: ${displayModeLabel()}`;
}

/* ========== 提示 ========== */

let toastTimer = 0;
export function toast(text: string): void {
  let t = document.getElementById("rb-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "rb-toast";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2200);
}

export function showMessage(title: string, text: string): void {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `
    <div class="modal-content">
      <div class="modal-header"><span></span><button>✕</button></div>
      <div class="modal-body" style="padding:16px;font-size:13px;line-height:1.7;white-space:pre-wrap;max-height:60vh;overflow:auto"></div>
      <div class="modal-footer"><button class="msg-ok">确定</button></div>
    </div>`;
  (m.querySelector(".modal-header span") as HTMLElement).textContent = title;
  (m.querySelector(".modal-body") as HTMLElement).textContent = text;
  const close = () => m.remove();
  m.querySelector(".modal-header button")?.addEventListener("click", close);
  m.querySelector(".msg-ok")?.addEventListener("click", close);
  m.addEventListener("mousedown", (e) => {
    if (e.target === m) close();
  });
  document.body.appendChild(m);
}

/* ========== 启动 ========== */

export async function boot(): Promise<void> {
  try {
    state.store = mergeDefaults(await api.loadStore());
  } catch {
    state.store = defaultStore();
  }
  const s = state.store.settings;

  reader.init({ onProgress: onReaderProgress, onPageEnd });
  reader.setSpeed(s.scrollSpeed);
  reader.setMode(s.scrollMode === "page" ? "page" : "continuous");
  reader.setPageInterval(s.pageInterval);
  if (s.dualPage) reader.setDual(true);
  state.displayMode = (s.displayMode as DisplayMode) || "auto";

  applyAppearance();

  const { initMenubar } = await import("./menubar");
  const { initPanels } = await import("./panels");
  const { initFindbar } = await import("./findbar");
  const { initShortcuts } = await import("./shortcut");
  const { initKeywords } = await import("./keywords");
  const { initFolderPanel, openFolderPanel } = await import("./folder");
  const { imageViewerPlugin } = await import("./plugins/image-viewer");
  plugins.register(imageViewerPlugin);
  plugins.setEnabledMap(s.plugins);
  // 外部插件（.rbplugin 包）在内置插件注册完成后加载；失败只记入插件面板
  const { loadExternalPlugins, initPluginLoader } = await import("./plugins/loader");
  await loadExternalPlugins();
  initPluginLoader();
  plugins.initPluginSystem((id, on) => {
    const map = { ...(state.store.settings.plugins || {}) };
    map[id] = on;
    state.store.settings.plugins = map;
    persist();
    plugins.setEnabledMap(map);
    // 能力变化 → 文件夹栏的可打开集合与"插件"菜单立即刷新
    document.dispatchEvent(new CustomEvent("rb-plugins-changed"));
    void import("./folder").then((f) => f.refreshPanel());
  });
  initMenubar();
  initPanels();
  initFindbar();
  initShortcuts();
  initKeywords();
  initFolderPanel();
  initDropdown();
  initEditModal();
  initDblClickEdit();
  initReaderContextMenu();
  initEncodingSwitcher();
  initDragDrop();

  updateUI();
  startReadTicker();

  window.addEventListener("beforeunload", () => persistNow());

  // 启动自动恢复上次阅读（失败只轻提示，不弹错误框）
  if (s.autoRestore && s.lastFilePath) {
    openPath(s.lastFilePath, { ratio: s.lastScroll, quiet: true });
  }

  // 启动自动打开文件夹侧栏（记住上次文件夹）
  if (s.folderAutoOpen && s.lastFolderPath) {
    void openFolderPanel();
  }
}

/* 拖拽打开 */
async function initDragDrop(): Promise<void> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "drop" && ev.payload.paths.length) {
        openPath(ev.payload.paths[0]);
      }
    });
  } catch {
    /* 拖拽不可用时忽略 */
  }
}
