/* 查找：? 通配任意一个英文字母或汉字，全部高亮 + 逐个跳转 */
import * as reader from "./reader";
import { state, currentDisplayText, renderContent, pushPosition } from "./app";

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

interface Match {
  start: number;
  end: number;
}

let matches: Match[] = [];
let current = -1;
let open = false;
let debounce = 0;

const input = () => $("find-input") as HTMLInputElement;
const countLabel = () => $("find-count");

/* ? → 匹配任意一个英文字母或汉字；其余字符按字面量 */
function buildRegex(q: string): RegExp | null {
  if (!q) return null;
  let pat = "";
  for (const ch of q) {
    if (ch === "?") {
      pat += "[A-Za-z\\u4e00-\\u9fa5]";
    } else {
      pat += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(pat, "gi");
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function isFindOpen(): boolean {
  return open;
}

function openFind(): void {
  if (!state.filePath) return;
  open = true;
  $("find-bar").classList.remove("hidden");
  const sel = window.getSelection()?.toString() ?? "";
  if (sel && sel.length <= 60 && !input().value) input().value = sel;
  input().focus();
  input().select();
  runSearch(1);
}

export function closeFind(): void {
  if (!open) return;
  open = false;
  $("find-bar").classList.add("hidden");
  matches = [];
  current = -1;
  renderContent(reader.getRatio()); // 恢复纯文本渲染
}

export function findNext(): void {
  if (matches.length === 0) return;
  pushPosition();
  current = (current + 1) % matches.length;
  highlight(current);
}

export function findPrev(): void {
  if (matches.length === 0) return;
  pushPosition();
  current = (current - 1 + matches.length) % matches.length;
  highlight(current);
}

function runSearch(dir: 1 | -1): void {
  const q = input().value;
  const text = currentDisplayText();
  if (!q || !text) {
    matches = [];
    countLabel().textContent = "";
    return;
  }
  const re = buildRegex(q);
  if (!re) return;

  matches = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++;
    if (matches.length >= 20000) break;
  }

  if (matches.length === 0) {
    current = -1;
    countLabel().textContent = "无匹配";
    highlight(-1);
    return;
  }

  // 从当前阅读位置附近开始定位
  const startOff = Math.floor(reader.getRatio() * text.length);
  if (dir === 1) {
    const idx = matches.findIndex((mm) => mm.start >= startOff);
    current = idx === -1 ? 0 : idx;
  } else {
    let prev = -1;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].start < startOff) prev = i;
    }
    current = prev === -1 ? matches.length - 1 : prev;
  }
  highlight(current);
}

function highlight(cur: number): void {
  const text = currentDisplayText();
  if (matches.length === 0) {
    renderContent(reader.getRatio());
    return;
  }
  const parts: string[] = [];
  let pos = 0;
  for (let i = 0; i < matches.length; i++) {
    const { start, end } = matches[i];
    parts.push(escapeHtml(text.slice(pos, start)));
    parts.push(`<mark class="find-highlight${i === cur ? " current" : ""}">`);
    parts.push(escapeHtml(text.slice(start, end)));
    parts.push("</mark>");
    pos = end;
  }
  parts.push(escapeHtml(text.slice(pos)));
  reader.setContentHTML(parts.join(""));
  countLabel().textContent = `${cur + 1}/${matches.length}`;
  if (cur >= 0) {
    const mark = document.querySelector("#reader-content mark.current");
    mark?.scrollIntoView({ block: "center" });
  }
}

export function initFindbar(): void {
  $("find-close").addEventListener("click", closeFind);
  $("find-next-btn").addEventListener("click", findNext);
  $("find-prev-btn").addEventListener("click", findPrev);

  input().addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else if (matches.length === 0) runSearch(1);
      else findNext();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeFind();
    }
  });
  input().addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => runSearch(1), 300);
  });

  document.addEventListener("rb-open-find", () => openFind());
  document.addEventListener("rb-escape", () => closeFind());
}
