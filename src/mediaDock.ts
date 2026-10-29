/* 媒体坞：全局底部栏（设计 docs/多标签页、媒体坞与设置中心方案.md §2）。
   插件视图实例把播放控件作为「媒体会话」注册至此：
   - 激活 tab 的会话 → 完整控制行（实例自管 element 直接挂载）
   - 后台播放中的会话 → 迷你条（点击跳回该 tab，⏸/▶ 经 rb-dock-toggle 分发）
   未来音频插件复用同一 API：音频无舞台画面，天然常驻迷你条（边听边看）。
   时间/进度由实例直接写自己的 element，不经过本模块（避免高频重排）。 */

export interface MediaSession {
  id: string; // = 插件视图实例 id
  kind: "video" | "audio";
  title: string;
  element: HTMLElement; // 完整控制行 DOM（实例自建自管，dock 挂入后常驻，不随 render 摘挂）
  isPlaying(): boolean;
}

const sessions = new Map<string, MediaSession>();
let activeViewId = "";
let dock: HTMLElement | null = null;
/** 完整行容器：常驻 #media-dock 首位，激活会话的 element 只在成为激活时挂入一次，
 *  跨 render 保留在 DOM（播放态高频 refresh 不再摘挂，拖动滑杆不中断） */
let fullWrap: HTMLElement | null = null;
/** 迷你条 (id,标题,播放态) 指纹：相同跳过重建，消除播放态高频 churn */
let miniKey = "";

function el(): HTMLElement {
  if (!dock) dock = document.getElementById("media-dock")!;
  return dock;
}

export function attach(s: MediaSession): void {
  sessions.set(s.id, s);
  render();
}

export function detach(id: string): void {
  sessions.delete(id);
  render();
}

/** 会话标题变化（视频换文件）：重排迷你条文案 */
export function update(id: string, patch: Partial<Pick<MediaSession, "title">>): void {
  const s = sessions.get(id);
  if (!s) return;
  Object.assign(s, patch);
  render();
}

/** 播放态变化后重排（迷你条只在播放中出现；实例的 play/pause 事件回调里调用） */
export function refresh(): void {
  render();
}

/** 激活 tab 的视图 id 变化（registry activateView/hideActiveView/closeView 调用） */
export function setActiveView(id: string): void {
  activeViewId = id;
  render();
}

function render(): void {
  const d = el();
  const active = activeViewId ? sessions.get(activeViewId) : null;
  const minis = [...sessions.values()].filter((s) => s.id !== activeViewId && s.isPlaying());
  if (!active && minis.length === 0) {
    d.classList.add("hidden");
    return; // 仅隐藏不摘 DOM：完整行保持挂载，再次显示零成本
  }
  d.classList.remove("hidden");
  if (active) {
    if (!fullWrap) {
      fullWrap = document.createElement("div");
      fullWrap.className = "md-full";
    }
    if (fullWrap.parentElement !== d) d.prepend(fullWrap); // 保持首位（迷你条在其后）
    fullWrap.classList.remove("hidden");
    if (active.element.parentElement !== fullWrap)
      fullWrap.replaceChildren(active.element); // 换挂新激活会话，同时清掉已销毁实例的遗留 element
  } else {
    fullWrap?.classList.add("hidden"); // 无激活会话：完整行隐藏但保留挂载，不摘 DOM
  }
  // 迷你条区：指纹（id+标题+播放态）相同则跳过重建
  const key = minis.map((s) => `${s.id} ${s.title} ${s.isPlaying()}`).join("");
  if (key === miniKey) return;
  miniKey = key;
  d.querySelectorAll(".md-mini").forEach((n) => n.remove());
  for (const s of minis) {
    const mini = document.createElement("div");
    mini.className = "md-mini";
    mini.title = `${s.title}（点击切换到该标签页）`;
    const ic = document.createElement("span");
    ic.className = "md-mini-icon";
    ic.textContent = s.kind === "video" ? "🎬" : "🎵";
    const ti = document.createElement("span");
    ti.className = "md-mini-title";
    ti.textContent = s.title;
    const pb = document.createElement("button");
    pb.className = "md-mini-play";
    pb.textContent = "⏸"; // 迷你条仅在播放中出现
    pb.title = "暂停/继续";
    pb.addEventListener("click", (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent("rb-dock-toggle", { detail: s.id }));
    });
    mini.append(ic, ti, pb);
    mini.addEventListener("click", () =>
      document.dispatchEvent(new CustomEvent("rb-dock-focus", { detail: s.id }))
    );
    d.appendChild(mini);
  }
}
