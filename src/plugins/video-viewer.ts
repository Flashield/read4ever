/* 视频查看插件：播放常见视频格式（含 zip 内视频）。
   基础功能：播放/暂停、进度条跳转、时间显示、倍速、音量/静音、全屏、
   同目录/同压缩包内上一个/下一个、自动连播。
   大文件：声明 wantsStream——本地文件、本地 zip 存储型条目与 SMB 远程普通文件走宿主 readbook-stream://
   协议（HTTP Range 分块，2GB+ 不整读内存），流式失败（远程 zip 条目、压缩条目等）自动回退字节整读。
   移动端就绪（docs/iOS移植方案.md D3/D4）：<video playsinline>、纯点击交互、
   触屏隐藏音量控件（iOS 音量由系统控制）、
   全屏走宿主公共沉浸模块（fullscreen.ts）；自动播放被策略拒绝时静默停在首帧。
   多实例：视图态全部迁入 VideoView 类（每个标签页独立实例）；
   用户偏好（自动连播/倍速）保持模块级共享。 */
import * as app from "../app";
import { toggle as fsToggle } from "../fullscreen";
import { activeViewId, instanceOf, pluginSetting, setPluginSetting } from "./registry";
import type { MenuItemDef } from "../dropdown";
import type { PluginOpenContext, PluginViewInstance, ReadBookPlugin } from "./types";

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

/* 固定设置（持久化于 settings.pluginSettings；模块级共享用户偏好） */
let autoplayNext = pluginSetting<boolean>(PID, "autoplayNext", true);
let defaultRate = pluginSetting<number>(PID, "rate", 1);

/** 菜单动作的视图侧落点：当前激活视图若为本插件的实例则返回之
 *  （无视图/其他插件视图激活时为 null，菜单只改设置不动视图，与旧版行为一致） */
function liveView(): VideoView | null {
  const inst = instanceOf(activeViewId());
  return inst instanceof VideoView ? inst : null;
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

const extMime = (p: string): string => {
  const m = p.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && MIME[m[0]]) || "video/mp4";
};

const fmtTime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
};

/* ========== 视图实例 ========== */

class VideoView implements PluginViewInstance {
  viewId = "";
  private ctx: PluginOpenContext | null = null;
  private video: HTMLVideoElement | null = null;
  private globalIdx = 0;
  private seeking = false; // 用户正在拖进度条：timeupdate 暂不回写滑杆
  private currentStream = false; // 当前视频是否走流式 URL（错误回退判断用）
  private urlCache = new Map<string, string>();
  private streamFailed = new Set<string>(); // 流式失败的目标（压缩 zip 条目等）：会话内回退整读
  /** 流式失败后的自愈重试标记（每路径每次失败至多重试一次；元数据成功加载即重置） */
  private streamRetried = new Set<string>();
  private activeVisible = false; // 仅激活 tab 的实例响应键盘

  /* ========== DOM 查询（实例面板内） ========== */

  private q<T extends Element>(sel: string): T | null {
    return this.ctx ? (this.ctx.host.querySelector(sel) as T | null) : null;
  }

  /* ========== 字节 / URL ========== */

  private async ensureUrl(path: string): Promise<string> {
    const hit = this.urlCache.get(path);
    if (hit) return hit;
    const c = this.ctx;
    if (!c) throw new Error("视图已关闭");
    const bytes = await c.loadBytes(path);
    if (!this.ctx) throw new Error("视图已关闭"); // 等待期间被关闭：不创建 URL
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: extMime(path) });
    const url = URL.createObjectURL(blob);
    this.urlCache.set(path, url);
    if (this.urlCache.size > 4) {
      // 淘汰最旧的非当前条目
      const cur = this.ctx.siblings[this.globalIdx];
      const oldest = [...this.urlCache.keys()].find((k) => k !== cur);
      if (oldest) {
        const u = this.urlCache.get(oldest);
        this.urlCache.delete(oldest);
        if (u) URL.revokeObjectURL(u);
      }
    }
    return url;
  }

  /* ========== 加载与切换 ========== */

  private async loadVideo(index: number, autoplay: boolean): Promise<void> {
    if (!this.ctx || !this.video) return;
    this.globalIdx = Math.max(0, Math.min(index, this.ctx.siblings.length - 1));
    const path = this.ctx.siblings[this.globalIdx] || this.ctx.path;
    try {
      // 优先流式（2GB+ 文件按 Range 分块拉取，本地/本地 zip 存储型条目/SMB 普通文件）；失败过/不可流式（远程 zip 条目、浏览器演示）→ 字节整读
      const stream = !this.streamFailed.has(path) ? this.ctx.streamUrlFor?.(path) ?? null : null;
      const url = stream ?? (await this.ensureUrl(path));
      if (!this.ctx || !this.video) return;
      this.currentStream = !!stream;
      this.video.src = url;
      this.video.playbackRate = defaultRate;
      this.hideError();
      this.updateLabels();
      this.syncStatus();
      if (autoplay) {
        try {
          await this.video.play();
        } catch {
          /* 自动播放被拒（移动端策略）：停在首帧，点击播放按钮开始 */
        }
      }
    } catch (e) {
      this.showError(`无法读取视频：${String(e)}`);
    }
  }

  /** 上一个/下一个；fromEnded=true 表示播完自动连播（越界只提示不重复报） */
  private async nav(delta: number, fromEnded = false): Promise<void> {
    if (!this.ctx) return;
    const target = this.globalIdx + delta;
    if (target < 0) {
      app.toast("已经是第一个视频");
      return;
    }
    if (target >= this.ctx.siblings.length) {
      app.toast(fromEnded ? "播放结束：后面没有更多视频了" : "已经是最后一个视频");
      return;
    }
    // 保持播放状态：手动切换与连播都继续播
    const wasPlaying = fromEnded || !(this.video?.paused ?? true);
    await this.loadVideo(target, wasPlaying);
  }

  togglePlay(): void {
    if (!this.video) return;
    if (this.video.paused || this.video.ended) void this.video.play().catch(() => {});
    else this.video.pause();
  }

  navFile(delta: number): void {
    void this.nav(delta);
  }

  isPlaying(): boolean {
    return !!this.video && !this.video.paused && !this.video.ended;
  }

  /** 仅激活 tab 的实例接收全局事件（键盘）；后台实例挂起 */
  setActive(on: boolean): void {
    this.activeVisible = on;
  }

  private toggleMute(btn: HTMLElement): void {
    if (!this.video) return;
    this.video.muted = !this.video.muted;
    btn.textContent = this.video.muted || this.video.volume === 0 ? "🔇" : "🔊";
  }

  private bumpVolume(d: number): void {
    if (!this.video) return;
    this.video.volume = Math.min(1, Math.max(0, this.video.volume + d));
    const vol = this.q<HTMLInputElement>(".vv-volume");
    if (vol) vol.value = String(this.video.volume);
    const muteBtn = this.q<HTMLElement>('button[data-act="mute"]');
    if (muteBtn) muteBtn.textContent = this.video.muted || this.video.volume === 0 ? "🔇" : "🔊";
  }

  /** 全屏走公共沉浸模块：播放区随宿主铺满，插件栏吸附屏幕边缘碰边呼出；
     触屏下 requestFullscreen 被拒自动降级纯 CSS 沉浸（触屏 media query 保底常显插件栏） */
  private async toggleFullscreen(): Promise<void> {
    await fsToggle();
  }

  /* ========== 标签与状态上报 ========== */

  private updateLabels(): void {
    if (!this.ctx) return;
    const path = this.ctx.siblings[this.globalIdx] || this.ctx.path;
    const nameEl = this.q<HTMLElement>(".vv-name");
    if (nameEl) {
      nameEl.textContent = baseName(path);
      nameEl.title = path;
    }
    const pageEl = this.q<HTMLElement>(".vv-page");
    if (pageEl)
      pageEl.textContent =
        this.ctx.siblings.length > 1 ? `${this.globalIdx + 1}/${this.ctx.siblings.length}` : "";
  }

  /** 向宿主上报：窗口标题/右上角=打开的文件（zip 显示 zip 名），状态栏文件格=当前视频、
   *  位置格=播放时间、模式格=播放状态+倍速、显示格=连播状态。 */
  private syncStatus(): void {
    if (!this.ctx || !this.video) return;
    const path = this.ctx.siblings[this.globalIdx] || this.ctx.path;
    const m = path.match(/^(.+\.zip)::/i);
    const playing = !this.video.paused && !this.video.ended;
    const state = playing ? "播放中" : this.video.ended ? "已播完" : "已暂停";
    this.ctx.setStatus({
      title: baseName(m ? m[1] : path),
      file: baseName(path),
      encoding: this.video.videoWidth
        ? `${this.ctx.ext.replace(".", "").toUpperCase()} ${this.video.videoWidth}×${this.video.videoHeight}`
        : undefined,
      position: `${fmtTime(this.video.currentTime)} / ${fmtTime(this.video.duration)}`,
      mode: `${state} ${this.video.playbackRate}×`,
      display: autoplayNext ? "连播开" : "连播关",
    });
  }

  private showError(text: string): void {
    const el = this.q<HTMLElement>(".vv-error");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }

  private hideError(): void {
    this.q<HTMLElement>(".vv-error")?.classList.add("hidden");
  }

  /* ========== 键盘（插件视图内；桌面增强，触屏全部功能有按钮可达） ========== */

  /** 类字段箭头函数：注册/移除引用同一函数对象，且 this 恒绑定本实例 */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.activeVisible) return; // 后台实例不响应键盘
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable))
      return;
    switch (e.key) {
      case "ArrowLeft":
        if (this.video) this.video.currentTime = Math.max(0, this.video.currentTime - 5);
        break;
      case "ArrowRight":
        if (this.video && Number.isFinite(this.video.duration))
          this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 5);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.bumpVolume(0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        this.bumpVolume(-0.1);
        break;
      case "f":
      case "F":
        void this.toggleFullscreen();
        break;
    }
  };

  /* ========== 视图构建 ========== */

  private buildView(): void {
    if (!this.ctx) return;
    this.ctx.host.innerHTML = `
    <div class="vv">
      <div class="vv-bar plugin-topbar">
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
      <div class="vv-seekrow plugin-bottombar">
        <span class="vv-cur">0:00</span>
        <input class="vv-progress" type="range" min="0" max="1000" step="1" value="0" title="播放进度（←/→ 快退/快进 5 秒）" />
        <span class="vv-dur">0:00</span>
      </div>
    </div>`;

    this.video = this.q<HTMLVideoElement>(".vv-video")!;
    const progress = this.q<HTMLInputElement>(".vv-progress")!;
    const video = this.video;

    this.ctx.host.querySelector(".vv-bar")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
      if (!btn) return;
      switch (btn.dataset.act) {
        case "prev": void this.nav(-1); break;
        case "next": void this.nav(1); break;
        case "play": this.togglePlay(); break;
        case "mute": this.toggleMute(btn); break;
        case "fs": void this.toggleFullscreen(); break;
        case "close": this.ctx?.closeView(); break;
      }
    });

    const rateSel = this.q<HTMLSelectElement>(".vv-rate")!;
    rateSel.value = String(defaultRate);
    rateSel.addEventListener("change", () => {
      defaultRate = Number(rateSel.value) || 1;
      setPluginSetting(PID, "rate", defaultRate);
      if (this.video) this.video.playbackRate = defaultRate;
      this.syncStatus();
    });

    this.q<HTMLInputElement>(".vv-volume")!.addEventListener("input", (e) => {
      if (!this.video) return;
      this.video.volume = Number((e.target as HTMLInputElement).value);
      const muteBtn = this.q<HTMLElement>('button[data-act="mute"]');
      if (muteBtn) muteBtn.textContent = this.video.muted || this.video.volume === 0 ? "🔇" : "🔊";
    });

    progress.addEventListener("pointerdown", () => (this.seeking = true));
    progress.addEventListener("input", () => {
      if (this.video && Number.isFinite(this.video.duration) && this.video.duration > 0)
        this.video.currentTime = (Number(progress.value) / 1000) * this.video.duration;
    });
    progress.addEventListener("change", () => (this.seeking = false));
    progress.addEventListener("pointerup", () => (this.seeking = false));

    video.addEventListener("timeupdate", () => {
      if (!this.video || !this.ctx) return;
      if (!this.seeking && Number.isFinite(this.video.duration) && this.video.duration > 0)
        progress.value = String(Math.round((this.video.currentTime / this.video.duration) * 1000));
      const cur = this.q<HTMLElement>(".vv-cur");
      if (cur) cur.textContent = fmtTime(this.video.currentTime);
      const dur = this.q<HTMLElement>(".vv-dur");
      if (dur) dur.textContent = fmtTime(this.video.duration);
      this.syncStatus();
    });

    video.addEventListener("loadedmetadata", () => {
      const p = this.ctx?.siblings[this.globalIdx] || this.ctx?.path;
      if (p) this.streamRetried.delete(p); // 新一轮请求真拿到数据：恢复一次重试机会
      const dur = this.q<HTMLElement>(".vv-dur");
      if (dur && this.video) dur.textContent = fmtTime(this.video.duration);
      this.syncStatus();
    });

    const syncPlayBtn = () => {
      const btn = this.q<HTMLElement>('button[data-act="play"]');
      if (btn && this.video) btn.textContent = this.video.paused ? "▶" : "⏸";
      this.ctx?.setKeepAwake(!!this.video && !this.video.paused && !this.video.ended); // 播放中保持常亮（幂等）
      this.syncStatus();
    };
    video.addEventListener("play", syncPlayBtn);
    video.addEventListener("pause", syncPlayBtn);
    video.addEventListener("ended", () => {
      syncPlayBtn();
      if (autoplayNext) void this.nav(1, true);
    });
    video.addEventListener("error", () => {
      // 流式失败（如压缩 zip 条目、协议不可用、网络抖动）→ 先原样重试一次躲过瞬时抖动
      //（SMB 断线自愈在「下一次请求」才生效）；仍失败则记忆并回退字节整读；再失败按编码不支持提示
      const p = this.ctx?.siblings[this.globalIdx] || this.ctx?.path;
      if (this.currentStream && this.video && p && !this.streamFailed.has(p)) {
        if (!this.streamRetried.has(p)) {
          this.streamRetried.add(p);
          void this.loadVideo(this.globalIdx, !this.video.paused);
          return;
        }
        this.streamFailed.add(p);
        void this.loadVideo(this.globalIdx, !this.video.paused);
        return;
      }
      this.showError("无法播放：浏览器不支持该视频编码（如部分 mkv / AVI 编码）。");
      this.syncStatus();
    });

    window.addEventListener("keydown", this.onKey);
  }

  /* ========== 实例生命周期 ========== */

  open(c: PluginOpenContext): void {
    this.ctx = c;
    this.viewId = c.viewId;
    this.globalIdx = Math.max(0, Math.min(c.siblingIndex, c.siblings.length - 1));
    this.buildView();
    c.setKeepAwake(false); // 同实例换文件重开：重置常亮持有（play 事件会重新持有）
    void this.loadVideo(this.globalIdx, true);
  }

  deactivate(): void {
    window.removeEventListener("keydown", this.onKey);
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    for (const u of this.urlCache.values()) URL.revokeObjectURL(u);
    this.urlCache.clear();
    this.streamFailed.clear();
    this.streamRetried.clear(); // 会话残留标记不清会导致重开文件时首次错误跳过重试直降级
    this.currentStream = false;
    this.video = null;
    this.ctx = null;
  }

  /* ========== 插件固定设置菜单的视图侧同步 ========== */

  /** 菜单改默认倍速后的同步（无存活实例时 menu 侧跳过，等同旧版 video 为 null 的空转） */
  applyMenuRate(r: number): void {
    if (this.video) this.video.playbackRate = r;
    const sel = this.q<HTMLSelectElement>(".vv-rate");
    if (sel) sel.value = String(r);
    this.syncStatus();
  }

  /** 菜单切换自动连播后的状态栏同步 */
  applyMenuSync(): void {
    this.syncStatus();
  }
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
        liveView()?.applyMenuSync();
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
            liveView()?.applyMenuRate(r);
          },
        })),
    },
  ];
}

/* ========== 插件定义 ========== */

export const videoViewerPlugin: ReadBookPlugin = {
  id: PID,
  name: "视频查看",
  version: "1.3.0",
  description:
    "播放常见视频格式（含 zip 内视频）：播放/暂停、进度条跳转、倍速、音量/静音、全屏，同目录/同压缩包内上一个/下一个与自动连播；2GB+ 大文件走宿主流式协议按需分块（本地文件、本地 zip 存储型条目与 SMB 远程普通文件；远程 zip 条目回退整读）；支持多标签页多实例",
  extensions: EXTENSIONS,
  wantsStream: true,
  menu,
  createView: () => new VideoView(),
};
