/* 视频查看插件：播放常见视频格式（含 zip 内视频）。
   基础功能：播放/暂停、进度条跳转、时间显示、倍速、音量/静音、全屏、
   同目录/同压缩包内上一个/下一个、自动连播。
   大文件：声明 wantsStream——本地文件、本地 zip 存储型条目与 SMB 远程普通文件走宿主 readbook-stream://
   协议（HTTP Range 分块，2GB+ 不整读内存），流式失败（远程 zip 条目、压缩条目等）自动回退字节整读。
   移动端就绪（docs/iOS移植方案.md D3/D4）：<video playsinline>、纯点击交互、
   触屏隐藏音量控件（iOS 音量由系统控制）、桌面全屏走 requestFullscreen、
   触屏走 body.immersive 沉浸模式；自动播放被策略拒绝时静默停在首帧。 */
import * as app from "../app";
import { deactivateActive, pluginSetting, setPluginSetting } from "./registry";
import type { MenuItemDef } from "../dropdown";
import type { PluginOpenContext, ReadBookPlugin } from "./types";

const PID = "video-viewer";
const EXTENSIONS = [".mp4", ".m4v", ".webm", ".mov", ".ogv", ".mkv"];

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

/* 固定设置（持久化于 settings.pluginSettings） */
let autoplayNext = pluginSetting<boolean>(PID, "autoplayNext", true);
let defaultRate = pluginSetting<number>(PID, "rate", 1);

/* 视图状态 */
let ctx: PluginOpenContext | null = null;
let video: HTMLVideoElement | null = null;
let globalIdx = 0;
let seeking = false; // 用户正在拖进度条：timeupdate 暂不回写滑杆
let immersive = false; // 触屏沉浸全屏（body.immersive）生效中
let currentStream = false; // 当前视频是否走流式 URL（错误回退判断用）
const urlCache = new Map<string, string>();
const streamFailed = new Set<string>(); // 流式失败的目标（压缩 zip 条目等）：会话内回退整读
/** 流式失败后的自愈重试标记（每路径每次失败至多重试一次；元数据成功加载即重置） */
const streamRetried = new Set<string>();

const q = <T extends Element>(sel: string): T | null =>
  ctx ? (ctx.host.querySelector(sel) as T | null) : null;

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

const extMime = (p: string): string => {
  const m = p.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && MIME[m[0]]) || "video/mp4";
};

/** 触屏设备（无悬停 + 粗指针）：隐藏音量控件、全屏走沉浸模式 */
const isCoarse = (): boolean =>
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;

const fmtTime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
};

/* ========== 字节 / URL ========== */

async function ensureUrl(path: string): Promise<string> {
  const hit = urlCache.get(path);
  if (hit) return hit;
  if (!ctx) throw new Error("视图已关闭");
  const bytes = await ctx.loadBytes(path);
  if (!ctx) throw new Error("视图已关闭"); // 等待期间被关闭：不创建 URL
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: extMime(path) });
  const url = URL.createObjectURL(blob);
  urlCache.set(path, url);
  if (urlCache.size > 4) {
    // 淘汰最旧的非当前条目
    const cur = ctx.siblings[globalIdx];
    const oldest = [...urlCache.keys()].find((k) => k !== cur);
    if (oldest) {
      const u = urlCache.get(oldest);
      urlCache.delete(oldest);
      if (u) URL.revokeObjectURL(u);
    }
  }
  return url;
}

/* ========== 加载与切换 ========== */

async function loadVideo(index: number, autoplay: boolean): Promise<void> {
  if (!ctx || !video) return;
  globalIdx = Math.max(0, Math.min(index, ctx.siblings.length - 1));
  const path = ctx.siblings[globalIdx] || ctx.path;
  try {
    // 优先流式（2GB+ 文件按 Range 分块拉取，本地/本地 zip 存储型条目/SMB 普通文件）；失败过/不可流式（远程 zip 条目、浏览器演示）→ 字节整读
    const stream = !streamFailed.has(path) ? ctx.streamUrlFor?.(path) ?? null : null;
    const url = stream ?? (await ensureUrl(path));
    if (!ctx || !video) return;
    currentStream = !!stream;
    video.src = url;
    video.playbackRate = defaultRate;
    hideError();
    updateLabels();
    syncStatus();
    if (autoplay) {
      try {
        await video.play();
      } catch {
        /* 自动播放被拒（移动端策略）：停在首帧，点击播放按钮开始 */
      }
    }
  } catch (e) {
    showError(`无法读取视频：${String(e)}`);
  }
}

/** 上一个/下一个；fromEnded=true 表示播完自动连播（越界只提示不重复报） */
async function nav(delta: number, fromEnded = false): Promise<void> {
  if (!ctx) return;
  const target = globalIdx + delta;
  if (target < 0) {
    app.toast("已经是第一个视频");
    return;
  }
  if (target >= ctx.siblings.length) {
    app.toast(fromEnded ? "播放结束：后面没有更多视频了" : "已经是最后一个视频");
    return;
  }
  // 保持播放状态：手动切换与连播都继续播
  const wasPlaying = fromEnded || !(video?.paused ?? true);
  await loadVideo(target, wasPlaying);
}

function togglePlay(): void {
  if (!video) return;
  if (video.paused || video.ended) void video.play().catch(() => {});
  else video.pause();
}

function toggleMute(btn: HTMLElement): void {
  if (!video) return;
  video.muted = !video.muted;
  btn.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
}

function bumpVolume(d: number): void {
  if (!video) return;
  video.volume = Math.min(1, Math.max(0, video.volume + d));
  const vol = q<HTMLInputElement>(".vv-volume");
  if (vol) vol.value = String(video.volume);
  const muteBtn = q<HTMLElement>('button[data-act="mute"]');
  if (muteBtn) muteBtn.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
}

/** 桌面走 requestFullscreen；触屏（iOS 无元素全屏 API）走 body.immersive 沉浸模式 */
async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (immersive) {
    document.body.classList.remove("immersive");
    immersive = false;
    return;
  }
  const stage = q<HTMLElement>(".vv-stage");
  if (!isCoarse() && stage?.requestFullscreen) {
    try {
      await stage.requestFullscreen();
      return;
    } catch {
      /* 拒绝则落到沉浸模式 */
    }
  }
  document.body.classList.add("immersive");
  immersive = true;
}

/* ========== 标签与状态上报 ========== */

function updateLabels(): void {
  if (!ctx) return;
  const path = ctx.siblings[globalIdx] || ctx.path;
  const nameEl = q<HTMLElement>(".vv-name");
  if (nameEl) {
    nameEl.textContent = baseName(path);
    nameEl.title = path;
  }
  const pageEl = q<HTMLElement>(".vv-page");
  if (pageEl)
    pageEl.textContent = ctx.siblings.length > 1 ? `${globalIdx + 1}/${ctx.siblings.length}` : "";
}

/** 向宿主上报：窗口标题/右上角=打开的文件（zip 显示 zip 名），状态栏文件格=当前视频、
 *  位置格=播放时间、模式格=播放状态+倍速、显示格=连播状态。 */
function syncStatus(): void {
  if (!ctx || !video) return;
  const path = ctx.siblings[globalIdx] || ctx.path;
  const m = path.match(/^(.+\.zip)::/i);
  const playing = !video.paused && !video.ended;
  const state = playing ? "播放中" : video.ended ? "已播完" : "已暂停";
  ctx.setStatus({
    title: baseName(m ? m[1] : path),
    file: baseName(path),
    encoding: video.videoWidth
      ? `${ctx.ext.replace(".", "").toUpperCase()} ${video.videoWidth}×${video.videoHeight}`
      : undefined,
    position: `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`,
    mode: `${state} ${video.playbackRate}×`,
    display: autoplayNext ? "连播开" : "连播关",
  });
}

function showError(text: string): void {
  const el = q<HTMLElement>(".vv-error");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
}

function hideError(): void {
  q<HTMLElement>(".vv-error")?.classList.add("hidden");
}

/* ========== 键盘（插件视图内；桌面增强，触屏全部功能有按钮可达） ========== */

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable))
    return;
  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowLeft":
      if (video) video.currentTime = Math.max(0, video.currentTime - 5);
      break;
    case "ArrowRight":
      if (video && Number.isFinite(video.duration))
        video.currentTime = Math.min(video.duration, video.currentTime + 5);
      break;
    case "ArrowUp":
      e.preventDefault();
      bumpVolume(0.1);
      break;
    case "ArrowDown":
      e.preventDefault();
      bumpVolume(-0.1);
      break;
    case "f":
    case "F":
      void toggleFullscreen();
      break;
  }
}

/* ========== 视图构建 ========== */

function buildView(): void {
  if (!ctx) return;
  ctx.host.innerHTML = `
    <div class="vv">
      <div class="vv-bar">
        <span class="vv-name"></span>
        <span class="vv-page"></span>
        <span class="vv-spacer"></span>
        <button data-act="prev" title="上一个视频">◀</button>
        <button data-act="next" title="下一个视频">▶</button>
        <span class="vv-sep"></span>
        <button data-act="play" title="播放/暂停（Space）">▶</button>
        <select class="vv-rate" title="播放倍速">
          ${RATES.map((r) => `<option value="${r}">${r}×</option>`).join("")}
        </select>
        <button data-act="mute" title="静音">🔊</button>
        <input class="vv-volume" type="range" min="0" max="1" step="0.05" value="1" title="音量（↑/↓）" />
        <span class="vv-sep"></span>
        <button data-act="fs" title="全屏（F）">⛶</button>
        <button data-act="close" title="关闭视频，回到文本">✕</button>
      </div>
      <div class="vv-stage">
        <video class="vv-video" playsinline preload="metadata"></video>
        <div class="vv-error hidden"></div>
      </div>
      <div class="vv-seekrow">
        <span class="vv-cur">0:00</span>
        <input class="vv-progress" type="range" min="0" max="1000" step="1" value="0" title="播放进度（←/→ 快退/快进 5 秒）" />
        <span class="vv-dur">0:00</span>
      </div>
    </div>`;

  video = q<HTMLVideoElement>(".vv-video")!;
  const progress = q<HTMLInputElement>(".vv-progress")!;

  ctx.host.querySelector(".vv-bar")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
    if (!btn) return;
    switch (btn.dataset.act) {
      case "prev": void nav(-1); break;
      case "next": void nav(1); break;
      case "play": togglePlay(); break;
      case "mute": toggleMute(btn); break;
      case "fs": void toggleFullscreen(); break;
      case "close": deactivateActive(); break;
    }
  });

  const rateSel = q<HTMLSelectElement>(".vv-rate")!;
  rateSel.value = String(defaultRate);
  rateSel.addEventListener("change", () => {
    defaultRate = Number(rateSel.value) || 1;
    setPluginSetting(PID, "rate", defaultRate);
    if (video) video.playbackRate = defaultRate;
    syncStatus();
  });

  q<HTMLInputElement>(".vv-volume")!.addEventListener("input", (e) => {
    if (!video) return;
    video.volume = Number((e.target as HTMLInputElement).value);
    const muteBtn = q<HTMLElement>('button[data-act="mute"]');
    if (muteBtn) muteBtn.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  });

  progress.addEventListener("pointerdown", () => (seeking = true));
  progress.addEventListener("input", () => {
    if (video && Number.isFinite(video.duration) && video.duration > 0)
      video.currentTime = (Number(progress.value) / 1000) * video.duration;
  });
  progress.addEventListener("change", () => (seeking = false));
  progress.addEventListener("pointerup", () => (seeking = false));

  video.addEventListener("timeupdate", () => {
    if (!video || !ctx) return;
    if (!seeking && Number.isFinite(video.duration) && video.duration > 0)
      progress.value = String(Math.round((video.currentTime / video.duration) * 1000));
    const cur = q<HTMLElement>(".vv-cur");
    if (cur) cur.textContent = fmtTime(video.currentTime);
    const dur = q<HTMLElement>(".vv-dur");
    if (dur) dur.textContent = fmtTime(video.duration);
    syncStatus();
  });

  video.addEventListener("loadedmetadata", () => {
    const p = ctx?.siblings[globalIdx] || ctx?.path;
    if (p) streamRetried.delete(p); // 新一轮请求真拿到数据：恢复一次重试机会
    const dur = q<HTMLElement>(".vv-dur");
    if (dur && video) dur.textContent = fmtTime(video.duration);
    syncStatus();
  });

  const syncPlayBtn = () => {
    const btn = q<HTMLElement>('button[data-act="play"]');
    if (btn && video) btn.textContent = video.paused ? "▶" : "⏸";
    ctx?.setKeepAwake(!!video && !video.paused && !video.ended); // 播放中保持常亮（幂等）
    syncStatus();
  };
  video.addEventListener("play", syncPlayBtn);
  video.addEventListener("pause", syncPlayBtn);
  video.addEventListener("ended", () => {
    syncPlayBtn();
    if (autoplayNext) void nav(1, true);
  });
  video.addEventListener("error", () => {
    // 流式失败（如压缩 zip 条目、协议不可用、网络抖动）→ 先原样重试一次躲过瞬时抖动
    //（SMB 断线自愈在「下一次请求」才生效）；仍失败则记忆并回退字节整读；再失败按编码不支持提示
    const p = ctx?.siblings[globalIdx] || ctx?.path;
    if (currentStream && video && p && !streamFailed.has(p)) {
      if (!streamRetried.has(p)) {
        streamRetried.add(p);
        void loadVideo(globalIdx, !video.paused);
        return;
      }
      streamFailed.add(p);
      void loadVideo(globalIdx, !video.paused);
      return;
    }
    showError("无法播放：浏览器不支持该视频编码（如部分 mkv / AVI 编码）。");
    syncStatus();
  });

  window.addEventListener("keydown", onKey);
}

/* ========== 插件固定设置菜单（外层"视频查看"由注册表包装） ========== */

function menu(): MenuItemDef[] {
  return [
    {
      label: "自动连播",
      checked: () => autoplayNext,
      action: () => {
        autoplayNext = !autoplayNext;
        setPluginSetting(PID, "autoplayNext", autoplayNext);
        syncStatus();
        app.toast(autoplayNext ? "自动连播：播完接续下一个视频" : "已关闭自动连播");
      },
    },
    {
      label: "默认倍速",
      children: () =>
        RATES.map((r) => ({
          label: `${r}×`,
          checked: () => defaultRate === r,
          action: () => {
            defaultRate = r;
            setPluginSetting(PID, "rate", r);
            if (video) video.playbackRate = r;
            const sel = q<HTMLSelectElement>(".vv-rate");
            if (sel) sel.value = String(r);
            syncStatus();
          },
        })),
    },
  ];
}

/* ========== 插件定义 ========== */

export const videoViewerPlugin: ReadBookPlugin = {
  id: PID,
  name: "视频查看",
  version: "1.1.0",
  description:
    "播放常见视频格式（含 zip 内视频）：播放/暂停、进度条跳转、倍速、音量/静音、全屏，同目录/同压缩包内上一个/下一个与自动连播；2GB+ 大文件走宿主流式协议按需分块（本地文件、本地 zip 存储型条目与 SMB 远程普通文件；远程 zip 条目回退整读）",
  extensions: EXTENSIONS,
  wantsStream: true,
  menu,
  open(c: PluginOpenContext): void {
    ctx = c;
    globalIdx = Math.max(0, Math.min(c.siblingIndex, c.siblings.length - 1));
    buildView();
    void loadVideo(globalIdx, true);
  },
  deactivate(): void {
    window.removeEventListener("keydown", onKey);
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const u of urlCache.values()) URL.revokeObjectURL(u);
    urlCache.clear();
    streamFailed.clear();
    streamRetried.clear(); // 会话残留标记不清会导致重开文件时首次错误跳过重试直降级
    currentStream = false;
    if (immersive) {
      document.body.classList.remove("immersive");
      immersive = false;
    }
    video = null;
    ctx = null;
  },
};
