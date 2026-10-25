/* 关键词检索与统计：关键词组管理、当前文档统计、索引与跳转 */
import * as app from "./app";
import * as reader from "./reader";
import { currentDisplayText } from "./app";
import type { KeywordGroup } from "./types";

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const MAX_HITS = 20000; // 扫描上限（与查找栏一致）
const BATCH = 300; // 索引列表分批渲染条数
const CONTEXT_CHARS = 25; // 索引条目里关键词前后保留的字符数

interface Occurrence {
  kw: number; // 关键词在 index.keywords 中的下标
  start: number; // 在显示文本中的字符偏移
  end: number;
  line: number; // 1 起始逻辑行号（按换行符划分）
}

interface KwIndex {
  text: string;
  keywords: string[];
  occurrences: Occurrence[];
  lineStarts: number[];
}

let index: KwIndex | null = null;
let dirty = true;
let activeTab: "stats" | "index" = "stats";
let filterKw = -1; // 索引过滤：-1 全部，否则关键词下标
let visibleOccs: Occurrence[] = []; // 当前过滤下的命中列表（渲染与跳转共用）
let rendered = 0; // 已渲染条数

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ? → 任意一个英文字母或汉字，其余按字面量；忽略大小写（与查找栏一致） */
function buildRegex(kw: string): RegExp | null {
  if (!kw) return null;
  let pat = "";
  for (const ch of kw) {
    pat += ch === "?" ? "[A-Za-z\\u4e00-\\u9fa5]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(pat, "gi");
  } catch {
    return null;
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  let pos = text.indexOf("\n");
  while (pos !== -1) {
    starts.push(pos + 1);
    pos = text.indexOf("\n", pos + 1);
  }
  return starts;
}

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/* 某逻辑行的字符区间（去掉行尾 \r，兼容 Windows 换行） */
function lineRange(text: string, lineStarts: number[], line: number): [number, number] {
  const ls = lineStarts[line - 1];
  let le = line < lineStarts.length ? lineStarts[line] - 1 : text.length;
  if (le > ls && text.charCodeAt(le - 1) === 13) le--;
  return [ls, le];
}

/* ========== 数据 ========== */

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function activeGroup(): KeywordGroup | null {
  const groups = app.state.store.keywordGroups;
  if (groups.length === 0) return null;
  const id = app.state.store.settings.activeKeywordGroupId;
  return groups.find((g) => g.id === id) ?? groups[0];
}

/* 首次使用时自动建一个默认组 */
function ensureGroup(): void {
  const s = app.state.store;
  if (s.keywordGroups.length === 0) {
    s.keywordGroups.push({ id: genId(), name: "默认组", keywords: [] });
  }
  const g = activeGroup();
  if (g && s.settings.activeKeywordGroupId !== g.id) s.settings.activeKeywordGroupId = g.id;
  app.persist();
}

/* ========== 检索引擎 ========== */

function buildIndex(): void {
  const text = currentDisplayText();
  const group = activeGroup();
  const keywords: string[] = [];
  for (const raw of group?.keywords ?? []) {
    const kw = raw.trim();
    if (kw && !keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) keywords.push(kw);
  }
  const occurrences: Occurrence[] = [];
  const lineStarts = computeLineStarts(text);
  for (let ki = 0; ki < keywords.length && occurrences.length < MAX_HITS; ki++) {
    const re = buildRegex(keywords[ki]);
    if (!re) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      occurrences.push({
        kw: ki,
        start: m.index,
        end: m.index + m[0].length,
        line: lineOf(lineStarts, m.index),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (occurrences.length >= MAX_HITS) break;
    }
  }
  occurrences.sort((a, b) => a.start - b.start);
  index = { text, keywords, occurrences, lineStarts };
  dirty = false;
}

/* ========== 渲染 ========== */

function panelVisible(): boolean {
  return !$("keyword-panel").classList.contains("hidden");
}

function emptyHtml(msg: string): string {
  return `<div class="kw-empty">${msg}</div>`;
}

function switchTab(tab: "stats" | "index"): void {
  activeTab = tab;
  $("kw-tab-stats").classList.toggle("active", tab === "stats");
  $("kw-tab-index").classList.toggle("active", tab === "index");
  $("kw-stats").classList.toggle("hidden", tab !== "stats");
  $("kw-index").classList.toggle("hidden", tab !== "index");
  syncCurrentTab(tab === "index");
}

function syncCurrentTab(reset: boolean): void {
  if (dirty) buildIndex();
  if (activeTab === "stats") renderStats();
  else renderIndex(reset);
}

function renderStats(): void {
  const box = $("kw-stats");
  if (!app.state.filePath) {
    box.innerHTML = emptyHtml("请先打开一个文件，再进行检索统计。");
    return;
  }
  if (!index || index.keywords.length === 0) {
    box.innerHTML = emptyHtml("当前组还没有关键词，请在上方输入并添加。");
    return;
  }
  const counts = index.keywords.map(() => 0);
  const lineSets = index.keywords.map(() => new Set<number>());
  for (const occ of index.occurrences) {
    counts[occ.kw]++;
    lineSets[occ.kw].add(occ.line);
  }
  const maxCount = Math.max(1, ...counts);
  const covered = new Set<number>();
  for (const occ of index.occurrences) covered.add(occ.line);

  // 按命中频次降序展示（次数相同保持定义顺序）
  const kwIndex = index;
  const order = kwIndex.keywords.map((_, i) => i).sort((a, b) => counts[b] - counts[a] || a - b);
  const rows = order
    .map(
      (i) => `
      <div class="kw-stats-row" data-ki="${i}" title="点击查看「${escapeHtml(kwIndex.keywords[i])}」的索引">
        <div class="kw-stats-head">
          <span class="kw-stats-name kw-c${i % 6}">${escapeHtml(kwIndex.keywords[i])}</span>
          <span class="kw-stats-count">${counts[i]} 处 · ${lineSets[i].size} 行</span>
        </div>
        <div class="kw-bar"><div class="kw-bar-fill kw-c${i % 6}" style="width:${Math.round((counts[i] / maxCount) * 100)}%"></div></div>
      </div>`
    )
    .join("");
  box.innerHTML =
    `<div class="kw-summary">文档共 ${index.text.length.toLocaleString()} 字 · 命中 ${index.occurrences.length.toLocaleString()} 处 · 覆盖 ${covered.size} 行</div>` +
    rows +
    `<div class="kw-hint">按命中频次排序 · 点击关键词行可查看其索引明细</div>`;
}

function contextHtml(occ: Occurrence): string {
  const { text, lineStarts } = index!;
  const [ls, le] = lineRange(text, lineStarts, occ.line);
  const from = Math.max(ls, occ.start - CONTEXT_CHARS);
  const to = Math.min(le, occ.end + CONTEXT_CHARS);
  // 前文/后文各自可收缩省略，关键词 mark 永不收缩——窄面板下也保证完整可见
  return (
    `<span class="kw-lead">` +
    escapeHtml((from > ls ? "…" : "") + text.slice(from, occ.start)) +
    `</span>` +
    `<mark class="kw-mark kw-c${occ.kw % 6}">` +
    escapeHtml(text.slice(occ.start, occ.end)) +
    "</mark>" +
    `<span class="kw-tail">` +
    escapeHtml(text.slice(occ.end, to) + (to < le ? "…" : "")) +
    `</span>`
  );
}

function renderIndex(reset: boolean): void {
  const box = $("kw-index");
  if (!app.state.filePath) {
    box.innerHTML = emptyHtml("请先打开一个文件，再进行检索。");
    return;
  }
  if (!index || index.keywords.length === 0) {
    box.innerHTML = emptyHtml("当前组还没有关键词，请在上方输入并添加。");
    return;
  }
  if (filterKw >= index.keywords.length) filterKw = -1;
  visibleOccs = filterKw === -1 ? index.occurrences : index.occurrences.filter((o) => o.kw === filterKw);

  const opts = ['<option value="-1">全部关键词</option>']
    .concat(
      index.keywords.map(
        (kw, i) => `<option value="${i}"${i === filterKw ? " selected" : ""}>${escapeHtml(kw)}</option>`
      )
    )
    .join("");
  const head = `<div class="kw-index-head"><select id="kw-filter">${opts}</select><span id="kw-index-count">共 ${visibleOccs.length.toLocaleString()} 处</span></div>`;

  if (reset || !box.querySelector(".kw-index-head")) {
    rendered = 0;
    box.innerHTML = head + `<div id="kw-hits"></div>`;
  }
  const hits = box.querySelector("#kw-hits") as HTMLElement;
  if (visibleOccs.length === 0) {
    hits.innerHTML = emptyHtml("没有找到命中。");
    rendered = 0;
    box.querySelector(".kw-more")?.remove();
    return;
  }

  const frag = document.createDocumentFragment();
  const upto = Math.min(visibleOccs.length, rendered + BATCH);
  for (let i = rendered; i < upto; i++) {
    const occ = visibleOccs[i];
    const row = document.createElement("div");
    row.className = "kw-hit";
    row.dataset.occ = String(i);
    row.title = "点击跳转到该处";
    row.innerHTML = `<span class="kw-line">行 ${occ.line}</span><span class="kw-ctx">${contextHtml(occ)}</span>`;
    frag.appendChild(row);
  }
  rendered = upto;
  hits.appendChild(frag);

  box.querySelector(".kw-more")?.remove();
  if (rendered < visibleOccs.length) {
    const more = document.createElement("button");
    more.className = "kw-more";
    more.textContent = `显示更多（已显示 ${rendered}/${visibleOccs.length}）`;
    more.addEventListener("click", () => renderIndex(false));
    box.appendChild(more);
  }
}

function rebuildGroupSelect(): void {
  const sel = $("kw-group-select") as HTMLSelectElement;
  sel.innerHTML = app.state.store.keywordGroups
    .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}（${g.keywords.length} 词）</option>`)
    .join("");
  const g = activeGroup();
  if (g) sel.value = g.id;
}

function rebuildChips(): void {
  const box = $("kw-chips");
  const g = activeGroup();
  if (!g || g.keywords.length === 0) {
    box.innerHTML = `<span class="kw-chips-empty">暂无关键词，请在下方添加</span>`;
    return;
  }
  box.innerHTML = g.keywords
    .map(
      (kw, i) =>
        `<span class="kw-chip">${escapeHtml(kw)}<button data-i="${i}" title="删除该关键词">✕</button></span>`
    )
    .join("");
}

/* ========== 动作 ========== */

function addKeyword(): void {
  const input = $("kw-input") as HTMLInputElement;
  const kw = input.value.trim();
  if (!kw) return;
  ensureGroup();
  const g = activeGroup()!;
  if (g.keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) {
    app.toast("该关键词已存在");
    return;
  }
  g.keywords.push(kw);
  input.value = "";
  app.persist();
  dirty = true;
  rebuildGroupSelect();
  rebuildChips();
  syncCurrentTab(true);
}

function deleteKeyword(i: number): void {
  const g = activeGroup();
  if (!g) return;
  const [kw] = g.keywords.splice(i, 1);
  app.persist();
  dirty = true;
  rebuildGroupSelect();
  rebuildChips();
  syncCurrentTab(true);
  app.toast(`已删除关键词「${kw}」`);
}

function addGroup(): void {
  const groups = app.state.store.keywordGroups;
  let n = groups.length + 1;
  while (groups.some((g) => g.name === `组${n}`)) n++;
  const g: KeywordGroup = { id: genId(), name: `组${n}`, keywords: [] };
  groups.push(g);
  app.state.store.settings.activeKeywordGroupId = g.id;
  app.persist();
  dirty = true;
  filterKw = -1;
  rebuildGroupSelect();
  rebuildChips();
  syncCurrentTab(true);
  app.toast(`已新建「${g.name}」`);
}

let delArmTimer = 0;
function disarmDel(btn: HTMLButtonElement): void {
  btn.dataset.armed = "";
  btn.textContent = "－组";
  btn.classList.remove("danger-arm");
}

function deleteGroup(): void {
  const btn = $("kw-group-del") as HTMLButtonElement;
  const groups = app.state.store.keywordGroups;
  const g = activeGroup();
  if (!g) return;
  // 两段式确认：3 秒内再点一次才真正删除
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "确认?";
    btn.classList.add("danger-arm");
    window.clearTimeout(delArmTimer);
    delArmTimer = window.setTimeout(() => disarmDel(btn), 3000);
    return;
  }
  disarmDel(btn);
  groups.splice(groups.indexOf(g), 1);
  const next = groups[0];
  if (next) {
    app.state.store.settings.activeKeywordGroupId = next.id;
  } else {
    const d: KeywordGroup = { id: genId(), name: "默认组", keywords: [] };
    groups.push(d);
    app.state.store.settings.activeKeywordGroupId = d.id;
  }
  app.persist();
  dirty = true;
  filterKw = -1;
  rebuildGroupSelect();
  rebuildChips();
  syncCurrentTab(true);
  app.toast(`已删除「${g.name}」`);
}

/* 重命名当前组：下拉框临时换成输入框，回车确认 / Esc 取消 */
function startRename(): void {
  const g = activeGroup();
  if (!g) return;
  const sel = $("kw-group-select") as HTMLSelectElement;
  if (sel.classList.contains("hidden")) return; // 已在重命名中
  const bar = sel.parentElement!;
  const input = document.createElement("input");
  input.className = "kw-rename-input";
  input.type = "text";
  input.maxLength = 30;
  input.value = g.name;
  input.title = "回车确认，Esc 取消";
  sel.classList.add("hidden");
  bar.insertBefore(input, sel);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    input.remove();
    sel.classList.remove("hidden");
    if (!save) return;
    const name = input.value.trim();
    if (!name || name === g.name) return;
    g.name = name;
    app.persist();
    rebuildGroupSelect();
    app.toast(`已重命名为「${name}」`);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 防止全局快捷键（如 Esc 关面板）打断重命名
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

let flashTimer = 0;

/* 点击索引条目：单处高亮重渲染 + 滚动到位，2 秒后恢复纯文本 */
function jump(occ: Occurrence): void {
  if (!index) return;
  if (index.text !== currentDisplayText()) {
    dirty = true;
    buildIndex();
    syncCurrentTab(true);
    return; // 索引已过期重建，让用户点新列表
  }
  const text = index.text;
  app.pushPosition();
  reader.setContentHTML(
    escapeHtml(text.slice(0, occ.start)) +
      `<mark class="kw-flash">${escapeHtml(text.slice(occ.start, occ.end))}</mark>` +
      escapeHtml(text.slice(occ.end))
  );
  const mark = document.querySelector("#reader-content mark.kw-flash") as HTMLElement | null;
  const el = document.getElementById("reader-content") as HTMLElement;
  mark?.scrollIntoView({ block: "center" });
  app.updateStatus();
  window.clearTimeout(flashTimer);
  const topAtFlash = el.scrollTop;
  flashTimer = window.setTimeout(() => {
    if (!mark || !mark.isConnected) return; // 内容已被其他渲染覆盖
    if (el.scrollTop !== topAtFlash) return; // 用户已手动滚动，不打断
    app.renderContent();
  }, 2000);
}

/* ========== 初始化 ========== */

export function initKeywords(): void {
  $("kw-tab-stats").addEventListener("click", () => switchTab("stats"));
  $("kw-tab-index").addEventListener("click", () => switchTab("index"));
  $("kw-add").addEventListener("click", addKeyword);
  $("kw-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addKeyword();
    }
  });
  $("kw-group-add").addEventListener("click", addGroup);
  $("kw-group-del").addEventListener("click", deleteGroup);
  $("kw-rename-btn").addEventListener("click", startRename);
  $("kw-group-select").addEventListener("change", () => {
    app.state.store.settings.activeKeywordGroupId = ($("kw-group-select") as HTMLSelectElement).value;
    app.persist();
    dirty = true;
    filterKw = -1;
    rebuildChips();
    syncCurrentTab(true);
  });

  // 关键词 chip 删除（事件委托）
  $("kw-chips").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-i]") as HTMLElement | null;
    if (btn) deleteKeyword(Number(btn.dataset.i));
  });

  // 统计行点击 → 切到索引并按该关键词过滤
  $("kw-stats").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".kw-stats-row") as HTMLElement | null;
    if (!row) return;
    filterKw = Number(row.dataset.ki);
    switchTab("index");
  });

  // 索引：过滤切换 + 条目点击跳转（事件委托）
  $("kw-index").addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "kw-filter") {
      filterKw = Number((t as HTMLSelectElement).value);
      renderIndex(true);
    }
  });
  $("kw-index").addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".kw-hit") as HTMLElement | null;
    if (!row) return;
    const occ = visibleOccs[Number(row.dataset.occ)];
    if (occ) jump(occ);
  });

  document.addEventListener("rb-open-panel", (e) => {
    if ((e as CustomEvent).detail !== "keyword-panel") return;
    ensureGroup();
    rebuildGroupSelect();
    rebuildChips();
    syncCurrentTab(true);
  });
  document.addEventListener("rb-content-changed", () => {
    dirty = true;
    if (panelVisible()) syncCurrentTab(true);
  });
}
