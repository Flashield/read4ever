/* 多标签页：tab 表与切换（设计 docs/多标签页、媒体坞与设置中心方案.md §1）。
   分层：一个 tab = 文本层快照 + 可选插件视图实例。app.state 始终代表激活 tab，
   切换 = 快照回旧 tab（含进度/时长落账）→ 恢复目标 tab → 重渲染或换显视图面板。
   后台 tab 的视图实例保活（面板 display:none，视频可按设置继续播放）。 */
import * as app from "./app";
import * as reader from "./reader";
import * as plugins from "./plugins/registry";

export interface TextSnapshot {
  filePath: string; // zip 为复合路径
  realPath: string;
  zipEntry: string;
  isZip: boolean;
  fileName: string;
  encoding: string;
  ratio: number; // 滚动位置 0..1（插件视图覆盖期间取打开插件前最近一次快照）
  readSeconds: number;
  modified: boolean;
  isHardLines: boolean;
  raw: string | null; // 有未落盘修改时驻留内存；否则 null（激活时重读）
}

export interface Tab {
  id: string;
  title: string;
  text: TextSnapshot | null;
  viewId: string; // 插件视图实例 id（"" 无）
  lazy: { path: string; ratio: number } | null; // 惰性恢复描述：首次激活才真正打开
  error: boolean; // 打开失败（文件失效等），保留可手动关闭
}

const tabs: Tab[] = [];
let activeId = "";

/* tab 激活近序(最新的在前):音频插件「最小化到坞」找最近激活的非音频 tab 用 */
const recentIds: string[] = [];
function touchRecent(id: string): void {
  const i = recentIds.indexOf(id);
  if (i >= 0) recentIds.splice(i, 1);
  recentIds.unshift(id);
}
/** 按最近激活排序的全部 tab id(新→旧) */
export function recentTabIds(): string[] {
  return [...recentIds];
}
/** tab 绑定的插件视图实例 id(无视图/未知 id 为 "") */
export function tabViewId(id: string): string {
  return tabs.find((t) => t.id === id)?.viewId ?? "";
}
/** 视图实例所属 tab id(未绑定/未知为 "") */
export function tabIdOfView(viewId: string): string {
  return tabs.find((t) => t.viewId === viewId)?.id ?? "";
}

/* 打开竞态防护：tab 集合/激活变化即递增，跨 await 的打开流程完成时校验，
   过期结果（内容/绑定/错误标记）一律丢弃，避免写进已失活的 tab */
let epoch = 0;
export function currentEpoch(): number {
  return epoch;
}
function bumpEpoch(): void {
  epoch++;
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function activeTab(): Tab | null {
  return tabs.find((t) => t.id === activeId) ?? null;
}

/* ========== 快照与恢复 ========== */

function snapshotFromState(): TextSnapshot | null {
  const s = app.state;
  if (!s.filePath) return null;
  return {
    filePath: s.filePath,
    realPath: s.realPath,
    zipEntry: s.zipEntry,
    isZip: s.isZip,
    fileName: s.fileName,
    encoding: s.encoding,
    ratio: plugins.isActive() ? 0 : reader.getRatio(),
    readSeconds: s.readSeconds,
    modified: s.modified,
    isHardLines: s.isHardLines,
    raw: s.modified ? s.raw : null,
  };
}

function restoreStateFields(snap: TextSnapshot): void {
  const s = app.state;
  s.filePath = snap.filePath;
  s.realPath = snap.realPath;
  s.zipEntry = snap.zipEntry;
  s.isZip = snap.isZip;
  s.fileName = snap.fileName;
  s.encoding = snap.encoding;
  s.readSeconds = snap.readSeconds;
  s.modified = snap.modified;
  s.isHardLines = snap.isHardLines;
  s.raw = snap.raw ?? "";
  s.prevPositions = [];
}

/** 当前激活 tab 失活前的落账：快照 + 进度/时长写回历史（与关闭文件同语义） */
function storeLiveInto(tab: Tab): void {
  if (tab.lazy || !tab.text) return; // 未装载（惰性/打开 pending/zip 待选/失败/纯视图）：没有文本层，state 属于别的 tab，快照进去会顶替其标题与内容
  const prev = tab.text;
  const snap = snapshotFromState();
  tab.text = snap;
  if (!snap) return;
  tab.title = snap.fileName;
  if (plugins.isActive() && prev) snap.ratio = prev.ratio; // 视图覆盖期间 getRatio 恒 0：保留此前抢存的文本比例
  if (!plugins.isActive()) {
    const h = app.state.store.history.find((x) => x.filePath === snap.filePath);
    if (h) h.position = snap.ratio;
    app.state.store.settings.lastFilePath = snap.filePath;
    app.state.store.settings.lastScroll = snap.ratio;
  }
}

/** 播放策略：切走后按设置暂停后台媒体（"continue" 时不打断） */
function applyPlaybackPolicy(): void {
  if (app.state.store.settings.tabSwitchPlayback === "continue") return;
  for (const t of tabs) {
    if (t.id === activeId || !t.viewId) continue;
    if (plugins.viewAllowsBackground(t.viewId)) continue; // 后台播放插件(音频):切标签页不打断
    const inst = plugins.instanceOf(t.viewId);
    try {
      if (inst?.isPlaying?.()) inst.togglePlay?.();
    } catch {
      /* 忽略 */
    }
  }
}

/* ========== 切换 / 新建 / 关闭 ========== */

export function switchToTab(id: string): void {
  if (id === activeId) return;
  const cur = activeTab();
  if (cur) storeLiveInto(cur);
  const target = tabs.find((t) => t.id === id);
  if (!target) return;
  activeId = id;
  touchRecent(id);
  bumpEpoch();
  activate(target);
  applyPlaybackPolicy();
  renderTabBar();
  app.persist();
}

/** 文本 tab 内容装载（activate 与 unbindView 关视图回退共用）：
 *  有驻留修改直接重渲染；否则重读文件（编码沿用快照，不重猜） */
function renderTextTab(snap: TextSnapshot): void {
  if (snap.raw === null) {
    // 无驻留修改：重读文件；短暂显示旧内容属可接受的加载间隙
    void app.openPath(snap.filePath, {
      ratio: snap.ratio,
      encoding: snap.encoding || undefined,
      quiet: true,
      tab: "replace",
    });
  } else {
    app.renderContent(snap.ratio);
    (document.getElementById("reader-content") as HTMLElement).focus();
    app.updateUI();
    // 关键词检索等的索引依赖该事件（app.notifyContentChanged 未导出，直接派发同款事件）
    document.dispatchEvent(new CustomEvent("rb-content-changed"));
  }
}

function activate(target: Tab): void {
  reader.stopScroll();
  if (target.lazy) {
    // 旧 tab 的视图面板先收起：否则其视图仍处激活态（registry.curActiveViewId 仍指它），
    // 惰性装载的文本会渲染在仍然可见的旧视图之后
    plugins.hideActiveView();
    const { path, ratio } = target.lazy;
    // lazy 标记保留到装载成功（loadFileContent 清除；失败保留可重试，
    // 窗口期内 descriptors 走 lazy 分支描述出正确路径）
    void app.openPath(path, { ratio, quiet: true, tab: "replace" });
    return; // openPath 完成内容装载与 UI 更新
  }
  if (target.viewId) {
    if (target.text) restoreStateFields(target.text); // 视图之下的文本层同步恢复（关视图回退用）
    plugins.activateView(target.viewId);
    return;
  }
  plugins.hideActiveView();
  if (target.text) {
    const snap = target.text;
    restoreStateFields(snap);
    renderTextTab(snap);
    return;
  }
  reader.showWelcome();
  app.updateUI();
}

export function createTab(title: string): Tab | null {
  const limit = Math.max(1, app.state.store.settings.tabLimit || 20);
  if (tabs.length >= limit) {
    app.toast(`标签页已达上限（${limit}），请先关闭部分标签页`);
    return null;
  }
  const cur = activeTab();
  if (cur) storeLiveInto(cur);
  const t: Tab = { id: crypto.randomUUID(), title, text: null, viewId: "", lazy: null, error: false };
  tabs.push(t);
  activeId = t.id;
  touchRecent(t.id);
  bumpEpoch();
  reader.stopScroll();
  plugins.hideActiveView(); // 旧 tab 的视图面板收起保活（归它自己的 tab）
  applyPlaybackPolicy(); // 新 tab 时后台媒体按设置暂停，与 switchToTab 一致
  renderTabBar();
  return t;
}

export function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  if (tab.viewId) plugins.closeView(tab.viewId); // rb-view-closed → unbindView（幂等）
  tabs.splice(idx, 1);
  const ri = recentIds.indexOf(id);
  if (ri >= 0) recentIds.splice(ri, 1);
  if (activeId === id) {
    activeId = "";
    bumpEpoch();
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) {
      switchToTab(next.id);
      applyPlaybackPolicy();
      return;
    }
    app.resetToWelcome();
  }
  renderTabBar();
  app.persist();
}

export function closeActiveTab(): void {
  if (activeId) closeTab(activeId);
}

/* ========== 绑定（app ↔ 视图实例） ========== */

/** 替换当前 tab 内容前：销毁其插件视图（翻页/惰性恢复语义）。
 *  先清 viewId 再 closeView：unbindView 找不到归属 tab，跳过文本层回退渲染——
 *  紧随其后的 loadFileContent 会装载新内容，回退渲染只会造成竞态。 */
export function destroyActiveView(): void {
  const t = activeTab();
  if (!t?.viewId) return;
  const vid = t.viewId;
  t.viewId = "";
  plugins.closeView(vid);
}

/** 插件视图覆盖 reader 前抢存激活 tab 文本比例（display:none 后 getRatio 恒 0） */
export function snapshotActiveRatio(): void {
  const t = activeTab();
  if (!t || plugins.isActive() || !app.state.filePath) return;
  if (!t.text) storeLiveInto(t);
  if (t.text) t.text.ratio = reader.getRatio();
}

/** 书签/历史跳转：把目标比例写进目标 tab 的快照/惰性描述（激活重读时吸附） */
export function applyJumpRatio(id: string, ratio: number): void {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.lazy) t.lazy.ratio = ratio;
  if (t.text) t.text.ratio = ratio;
}

/** 新打开的插件视图绑定到激活 tab */
export function bindView(viewId: string): void {
  const t = activeTab();
  if (!t) {
    plugins.closeView(viewId);
    return;
  }
  t.viewId = viewId;
  t.lazy = null;
  t.error = false;
  renderTabBar();
}

/** 视图关闭（✕/停用插件/单例被接管）：解除绑定，激活 tab 完整回退文本层
 *  （DOM 此前显示的可能是别的 tab 的文本，必须重渲染，否则状态栏与内容错位） */
function unbindView(viewId: string): void {
  const t = tabs.find((x) => x.viewId === viewId);
  if (!t) return;
  t.viewId = "";
  if (t.id === activeId) {
    if (t.text) {
      const snap = t.text;
      restoreStateFields(snap);
      renderTextTab(snap);
    } else {
      reader.showWelcome();
      app.updateUI();
    }
  }
  renderTabBar();
}

/** 激活 tab 打开失败：标记错误态（保留可手动关闭） */
export function markActiveError(): void {
  const t = activeTab();
  if (!t) return;
  t.error = true;
  renderTabBar();
}

/** 同文件已在某 tab（含惰性描述与插件视图当前路径）：返回该 tab */
export function tabForPath(path: string): Tab | null {
  const p = path.toLowerCase();
  return (
    tabs.find((t) => {
      if (t.lazy && t.lazy.path.toLowerCase() === p) return true;
      if (t.text && t.text.filePath.toLowerCase() === p) return true;
      return !!(t.viewId && plugins.viewPath(t.viewId).toLowerCase() === p);
    }) ?? null
  );
}

/** 媒体坞迷你条点击：跳到持有该视图的 tab */
export function switchToView(viewId: string): void {
  const t = tabs.find((x) => x.viewId === viewId);
  if (t) switchToTab(t.id);
}

export function cycleActive(delta: number): void {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  const n = tabs[(i + delta + tabs.length) % tabs.length];
  switchToTab(n.id);
}

/* ========== Tab bar 渲染 ========== */

function iconOf(t: Tab): string {
  if (t.viewId) {
    const pid = plugins.pluginIdOfView(t.viewId);
    if (pid === "video-viewer") return "🎬";
    if (pid === "image-viewer") return "🖼️";
    return "🧩";
  }
  return "📄";
}

function newTabEl(): HTMLElement {
  const el = document.createElement("div");
  el.className = "tab";
  const ic = document.createElement("span");
  ic.className = "tab-icon";
  const ti = document.createElement("span");
  ti.className = "tab-title";
  const x = document.createElement("button");
  x.className = "tab-close";
  x.textContent = "✕";
  x.title = "关闭标签页 (Ctrl+W)";
  el.append(ic, ti, x);
  return el;
}

/** 按 data-tab-id 调和更新 tab 栏：复用已有元素，只改 class/标题/图标与增删。
 *  不能 innerHTML 全量重建——重建落在某次点击的按下与抬起之间时，mousedown/mouseup
 *  目标不一致，浏览器把 click 派发到公共祖先，鼠标关 tab 会随机丢点击（要多点几次）。 */
export function renderTabBar(): void {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  bar.classList.toggle("hidden", tabs.length === 0);
  const stale = new Map<string, HTMLElement>();
  for (const el of Array.from(bar.children) as HTMLElement[]) {
    if (el.dataset.tabId) stale.set(el.dataset.tabId, el);
    else el.remove();
  }
  let prev: Element | null = null;
  for (const t of tabs) {
    let el = stale.get(t.id);
    if (el) stale.delete(t.id);
    else el = newTabEl();
    el.dataset.tabId = t.id; // 委托点击按它找 tab；缺失会被下轮当外来元素清掉且点击失效
    el.className = "tab" + (t.id === activeId ? " active" : "") + (t.error ? " error" : "");
    const ic = el.children[0] as HTMLElement;
    const icon = iconOf(t);
    if (ic.textContent !== icon) ic.textContent = icon;
    const ti = el.children[1] as HTMLElement;
    const name = t.title || "未命名";
    if (ti.textContent !== name) ti.textContent = name;
    if (ti.title !== t.title) ti.title = t.title;
    const ref: ChildNode | null = prev ? prev.nextSibling : bar.firstElementChild;
    if (ref !== el) bar.insertBefore(el, ref);
    prev = el;
  }
  for (const el of stale.values()) el.remove();
}

/* 交互委托在静态 #tab-bar 上：元素复用不再逐个挂监听，
   重渲染不再销毁光标下的元素，进行中的点击不受影响 */
const tabBar = document.getElementById("tab-bar");
tabBar?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const close = target.closest(".tab-close");
  if (close) {
    const id = close.closest<HTMLElement>(".tab")?.dataset.tabId;
    if (id) closeTab(id);
    return;
  }
  const tab = target.closest<HTMLElement>(".tab");
  if (tab?.dataset.tabId) switchToTab(tab.dataset.tabId);
});
tabBar?.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const tab = (e.target as HTMLElement).closest<HTMLElement>(".tab");
  if (tab?.dataset.tabId) closeTab(tab.dataset.tabId);
});

/** 激活视图上报标题变化时同步 tab 标题（app.updateUI 调用） */
export function setTitleByView(viewId: string, title: string): void {
  const t = tabs.find((x) => x.viewId === viewId);
  if (t && title && title !== "未打开文件") {
    t.title = title;
    renderTabBar();
  }
}

/* ========== 持久化与启动恢复 ========== */

export interface TabDescriptorLite {
  path: string;
  ratio: number;
}

/** 激活 tab 文本装载完成（app.loadFileContent 调用）：以活跃状态建立文本快照。
 *  此后 descriptors 对激活 tab 取 live 比例，重启即可恢复本 tab */
export function adoptActiveText(): void {
  const t = activeTab();
  if (!t) return;
  t.text = snapshotFromState();
}

/** 当前全部 tab 的持久化描述（app.persist 落盘前调用）。
 *  三项皆空（惰性已清、内容未装、视图未绑）的激活 tab 跳过：装载完成的
 *  loadFileContent → adoptActiveText 后再 persist 补正，避免窗口期把旧文件落成重复描述 */
export function descriptors(): TabDescriptorLite[] {
  const out: TabDescriptorLite[] = [];
  for (const t of tabs) {
    if (t.lazy) {
      out.push({ path: t.lazy.path, ratio: t.lazy.ratio });
    } else if (t.viewId) {
      out.push({ path: plugins.viewPath(t.viewId), ratio: t.text?.ratio ?? 0 });
    } else if (t.text) {
      out.push({
        path: t.text.filePath,
        ratio: t.id === activeId && !plugins.isActive() ? reader.getRatio() : t.text.ratio,
      });
    }
  }
  return out;
}

export function activeIndex(): number {
  return tabs.findIndex((t) => t.id === activeId);
}

/** 启动惰性重建：仅激活 tab 立即打开，后台 tab 首次点击才加载 */
export function restoreFrom(ds: TabDescriptorLite[], activeIdx: number): void {
  // 先过滤空 path 再入表：activeIdx 基于过滤后数组 clamp，空描述不再错位激活相邻 tab
  const list = ds.filter((d) => d && d.path);
  for (const d of list) {
    tabs.push({
      id: crypto.randomUUID(),
      title: baseName(d.path.split("::").pop() || d.path),
      text: null,
      viewId: "",
      lazy: { path: d.path, ratio: d.ratio },
      error: false,
    });
  }
  bumpEpoch();
  const i = Math.max(0, Math.min(activeIdx, tabs.length - 1));
  if (tabs[i]) switchToTab(tabs[i].id);
  else renderTabBar();
}

/* 视图关闭事件 → 解绑（registry closeView 派发；模块级自注册） */
document.addEventListener("rb-view-closed", (e) => {
  unbindView(String((e as CustomEvent).detail));
});
