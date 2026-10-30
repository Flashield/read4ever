/* 音频播放插件：播放常见音频格式（含 zip 内音频），打开文件所在目录/压缩包的音频自动组成目录队列。
   基础功能：播放/暂停、上一/下一首、进度跳转、倍速、音量/静音、循环模式三态（列表循环/单曲循环/播完停止）。
   大文件：wantsStream——本地文件、本地 zip 存储型条目与 SMB 远程普通文件走宿主 readbook-stream://
   协议（HTTP Range 分块），失败自动回退字节整读（api 层命令，SMB/zip 复合路径后端原生分发）。
   后台播放：backgroundPlayback 声明豁免切标签页暂停策略与托盘全停；后台时媒体坞迷你条可控（含切曲）。
   单流策略：一个音频视图开播时暂停其他播放中的音频视图（与视频不互斥）。
   多实例：视图态全部迁入 AudioView 类；用户偏好与播放列表/续播位置模块级共享（同 video 的 rate 模式）。 */
import * as app from "../app";
import { api } from "../api";
import * as mediaDock from "../mediaDock";
import { pluginSetting, setPluginSetting } from "./registry";
import type { PluginOpenContext, PluginViewInstance, ReadBookPlugin } from "./types";

const PID = "audio-viewer";
const EXTENSIONS = [".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wav"];

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

const extMime = (p: string): string => {
  const m = p.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && MIME[m[0]]) || "audio/mpeg";
};

const fmtTime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
};

/** zip 复合路径拆分（「zip路径::条目名」；普通路径 entry 为 ""） */
const splitZip = (path: string): { zipPath: string; entry: string } => {
  const m = path.match(/^(.+\.zip)::(.+)$/i);
  return m ? { zipPath: m[1], entry: m[2] } : { zipPath: "", entry: "" };
};

type LoopMode = "loop-list" | "loop-one" | "stop";
const LOOP_LABEL: Record<LoopMode, string> = { "loop-list": "列表循环", "loop-one": "单曲循环", stop: "播完停止" };
const LOOP_ICON: Record<LoopMode, string> = { "loop-list": "🔁", "loop-one": "🔂", stop: "➡" };

/* ========== 续播位置（模块级共享：path → 秒；上限 300 条，Map 插入序淘汰最旧） ========== */

const positions = new Map<string, number>();
try {
  const raw = pluginSetting<string>(PID, "positions", "");
  if (raw)
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>))
      if (typeof v === "number" && v > 0) positions.set(k, v);
} catch {
  /* 损坏忽略：无续播 */
}
let positionsDirty = false;

function setPosition(path: string, sec: number): void {
  positions.delete(path); // 重插到 Map 尾部 = 最近使用
  positions.set(path, sec);
  while (positions.size > 300) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
  positionsDirty = true;
}

function clearPosition(path: string): void {
  if (positions.delete(path)) {
    positionsDirty = true;
    persistPositions();
  }
}

function persistPositions(): void {
  if (!positionsDirty) return;
  positionsDirty = false;
  setPluginSetting(PID, "positions", JSON.stringify(Object.fromEntries(positions)));
}

/* 模块级共享用户偏好（持久化于插件设置） */
let loopMode = pluginSetting<LoopMode>(PID, "loopMode", "loop-list");
let defaultRate = pluginSetting<number>(PID, "rate", 1);
let volume = pluginSetting<number>(PID, "volume", 1);

/* 单流策略：全部存活音频视图实例表 */
const liveViews = new Set<AudioView>();

/* ========== 视图实例 ========== */

class AudioView implements PluginViewInstance {
  viewId = "";
  private ctx: PluginOpenContext | null = null;
  private audio: HTMLAudioElement | null = null;
  private dirQueue: string[] = []; // 目录队列（打开文件所在目录/压缩包派生，只读）
  private queue: string[] = []; // 当前生效队列（目录队列或某播放列表的副本）
  private currentPath = ""; // 当前（或上次）加载的曲目，独立于队列存在
  private seeking = false; // 用户正在拖进度条：timeupdate 暂不回写滑杆
  private failStreak = 0; // 连续解码失败计数（≥3 停止自动跳曲）
  private lastSlot = -1; // 15 秒粒度位置落盘槽位
  private failed = new Set<string>(); // 解码失败过的曲目（列表 ⚠ 标记）
  private loadSeq = 0; // 加载代号：快速连点时旧响应作废
  private activeVisible = false; // 仅激活 tab 的实例响应键盘
  private currentStream = false; // 当前曲目是否走流式 URL
  private urlCache = new Map<string, string>();
  private streamFailed = new Set<string>();
  private streamRetried = new Set<string>();
  private sessionEl: HTMLElement | null = null;
  private mdPlay: HTMLButtonElement | null = null;
  private mdCur: HTMLElement | null = null;
  private mdProgress: HTMLInputElement | null = null;
  private mdDur: HTMLElement | null = null;
  private miniExtra: HTMLElement | null = null;

  private q<T extends Element>(sel: string): T | null {
    return this.ctx ? (this.ctx.host.querySelector(sel) as T | null) : null;
  }

  /* ========== 字节 / URL ========== */

  /** 字节整读兜底（不受 loadBytes 目录边界约束：播放列表路径是用户自选的）
   *  zip 复合路径（含 SMB 远程 zip）走 read_zip_entry_bytes，后端原生分发 SMB */
  private async ensureBytesUrl(path: string): Promise<string> {
    const hit = this.urlCache.get(path);
    if (hit) return hit;
    const { zipPath, entry } = splitZip(path);
    const buf = entry ? await api.readZipBytes(zipPath, entry) : await api.readFileBytes(path);
    if (!this.ctx) throw new Error("视图已关闭"); // 等待期间被关闭：不创建 URL
    const blob = new Blob([buf], { type: extMime(path) });
    const url = URL.createObjectURL(blob);
    this.urlCache.set(path, url);
    if (this.urlCache.size > 4) {
      // 淘汰最旧的非当前条目
      const oldest = [...this.urlCache.keys()].find((k) => k !== this.currentPath);
      if (oldest) {
        const u = this.urlCache.get(oldest);
        this.urlCache.delete(oldest);
        if (u) URL.revokeObjectURL(u);
      }
    }
    return url;
  }

  /* ========== 加载与切换 ========== */

  /** 加载曲目；autoplay=false 仅装载（自动播放被策略拒绝后用户点播放的场景） */
  private async loadTrack(path: string, autoplay: boolean): Promise<void> {
    if (!this.ctx || !this.audio) return;
    const seq = ++this.loadSeq;
    this.saveCurrentPosition(); // 切曲：落盘上一曲位置
    this.currentPath = path;
    try {
      // 优先流式；失败过/不可流式（压缩 zip 条目、浏览器演示）→ 字节整读
      const stream = !this.streamFailed.has(path) ? this.ctx.streamUrlFor?.(path) ?? null : null;
      const url = stream ?? (await this.ensureBytesUrl(path));
      if (!this.ctx || !this.audio || seq !== this.loadSeq) return; // 等待期间被关闭或已切其他曲目
      this.currentStream = !!stream;
      this.audio.src = url;
      this.audio.playbackRate = defaultRate;
      this.audio.volume = volume;
      this.audio.loop = loopMode === "loop-one";
      this.lastSlot = -1;
      this.hideError();
      this.updateLabels();
      this.renderList();
      mediaDock.update(this.viewId, { title: baseName(path) });
      // 续播：位置 >3 秒才跳转并提示（跨视图/标签页共享，按 path 索引）
      const pos = positions.get(path);
      if (pos && pos > 3) {
        const a = this.audio;
        const seek = () => {
          if (this.audio === a && this.currentPath === path) {
            try {
              a.currentTime = pos;
            } catch {
              /* 已切走 */
            }
          }
        };
        if (a.readyState >= 1) seek();
        else a.addEventListener("loadedmetadata", seek, { once: true });
        app.toast(`已续播 ${fmtTime(pos)}`);
      }
      if (autoplay) {
        try {
          await this.audio.play();
        } catch {
          /* 自动播放被拒：停在装载态，点击播放按钮开始 */
        }
      }
    } catch (e) {
      this.showError(`无法读取音频：${String(e)}`);
      this.syncStatus();
    }
  }

  private playIndex(i: number): void {
    const p = this.queue[i];
    if (!p) return;
    this.failStreak = 0; // 手动点曲重置连败计数
    void this.loadTrack(p, true);
  }

  /** 上一/下一首；fromEnded=true 表示播完自动接续（列表循环回卷，播完停止模式收尾提示） */
  private async nav(delta: number, fromEnded = false): Promise<void> {
    if (!this.ctx || this.queue.length === 0) return;
    const i = this.queue.indexOf(this.currentPath);
    let target: number;
    if (i < 0) {
      target = delta > 0 ? 0 : this.queue.length - 1;
    } else {
      target = i + delta;
      if (fromEnded) {
        if (target >= this.queue.length) {
          if (loopMode !== "loop-list") {
            app.toast("播放结束");
            this.syncStatus();
            return;
          }
          target = 0; // 列表循环回卷
        }
      } else {
        if (target < 0) {
          app.toast("已经是第一首");
          return;
        }
        if (target >= this.queue.length) {
          app.toast("已经是最后一首");
          return;
        }
      }
    }
    await this.loadTrack(this.queue[target], true);
  }

  /* ========== 宿主公共入口 ========== */

  togglePlay(): void {
    if (!this.audio) return;
    if (this.audio.paused || this.audio.ended) {
      this.failStreak = 0; // 手动播放重置连败计数
      void this.audio.play().catch(() => {});
    } else {
      this.audio.pause();
    }
  }

  navFile(delta: number): void {
    void this.nav(delta);
  }

  isPlaying(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended;
  }

  setActive(on: boolean): void {
    this.activeVisible = on;
  }

  pauseIfPlaying(): void {
    if (this.audio && !this.audio.paused) this.audio.pause();
  }

  /** 记录当前曲目播放位置（ended 不记——播完的曲子重开从头播） */
  private saveCurrentPosition(): void {
    const p = this.currentPath;
    if (!this.audio || !p || this.audio.ended || this.audio.currentTime <= 0) return;
    setPosition(p, this.audio.currentTime);
  }

  /* ========== 标签与状态上报 ========== */

  private updateLabels(): void {
    const nameEl = this.q<HTMLElement>(".av-name");
    if (nameEl) {
      nameEl.textContent = baseName(this.currentPath);
      nameEl.title = this.currentPath;
    }
    const pageEl = this.q<HTMLElement>(".av-page");
    if (pageEl) {
      const i = this.queue.indexOf(this.currentPath);
      pageEl.textContent = this.queue.length > 1 ? `${i >= 0 ? i + 1 : "?"}/${this.queue.length}` : "";
    }
  }

  /** 状态栏：文件格=当前曲目、位置格=队列序号、编码格=格式大写、模式格=循环模式、显示格=播放态 */
  private syncStatus(): void {
    if (!this.ctx || !this.audio) return;
    const m = this.currentPath.match(/^(.+\.zip)::/i);
    const playing = this.isPlaying();
    this.ctx.setStatus({
      title: baseName(m ? m[1] : this.currentPath),
      file: baseName(this.currentPath),
      encoding: this.ctx.ext.replace(".", "").toUpperCase(),
      position:
        this.queue.length > 0
          ? `${Math.max(0, this.queue.indexOf(this.currentPath) + 1)}/${this.queue.length} 首`
          : "",
      mode: LOOP_LABEL[loopMode],
      display: playing ? "播放中" : this.audio.ended ? "已播完" : "已暂停",
    });
  }

  private showError(text: string): void {
    const el = this.q<HTMLElement>(".av-error");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }

  private hideError(): void {
    this.q<HTMLElement>(".av-error")?.classList.add("hidden");
  }

  /* ========== 键盘（桌面增强；Space 走宿主公共入口，不在此处理） ========== */

  private bumpVolume(d: number): void {
    if (!this.audio) return;
    volume = Math.min(1, Math.max(0, volume + d));
    setPluginSetting(PID, "volume", volume);
    this.audio.volume = volume;
    const vol = this.q<HTMLInputElement>(".av-volume");
    if (vol) vol.value = String(volume);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.activeVisible) return; // 后台实例不响应键盘
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable))
      return;
    switch (e.key) {
      case "ArrowLeft":
        if (this.audio) this.audio.currentTime = Math.max(0, this.audio.currentTime - 5);
        break;
      case "ArrowRight":
        if (this.audio && Number.isFinite(this.audio.duration))
          this.audio.currentTime = Math.min(this.audio.duration, this.audio.currentTime + 5);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.bumpVolume(0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        this.bumpVolume(-0.1);
        break;
    }
  };

  /* ========== 曲目列表 ========== */

  private renderList(): void {
    const box = this.q<HTMLElement>(".av-list");
    if (!box) return;
    box.innerHTML = "";
    this.queue.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "av-row" + (p === this.currentPath ? " cur" : "");
      const idx = document.createElement("span");
      idx.className = "av-idx";
      idx.textContent = String(i + 1);
      const ti = document.createElement("span");
      ti.className = "av-title";
      ti.textContent = baseName(p);
      ti.title = p;
      const st = document.createElement("span");
      st.className = "av-state";
      if (this.failed.has(p)) {
        st.textContent = "⚠";
        st.title = "上次播放失败";
        row.classList.add("bad");
      } else if (p === this.currentPath && this.isPlaying()) {
        st.textContent = "▶";
      }
      row.append(idx, ti, st);
      row.addEventListener("click", () => this.playIndex(i));
      box.appendChild(row);
    });
  }

  /* ========== 视图构建 ========== */

  private buildView(): void {
    if (!this.ctx) return;
    this.ctx.host.innerHTML = `
    <div class="av">
      <div class="av-bar plugin-topbar">
        <span class="av-name"></span>
        <span class="av-page"></span>
        <span class="av-spacer"></span>
        <button data-act="prev" title="上一首">⏮</button>
        <button data-act="play" title="播放/暂停（Space）">▶</button>
        <button data-act="next" title="下一首">⏭</button>
        <select class="av-rate" title="播放倍速">
          ${RATES.map((r) => `<option value="${r}">${r}×</option>`).join("")}
        </select>
        <button data-act="mute" title="静音">🔊</button>
        <input class="av-volume" type="range" min="0" max="1" step="0.05" title="音量（↑/↓）" />
        <span class="av-sep"></span>
        <button data-act="loop" title="循环模式">🔁</button>
        <button data-act="close" title="关闭播放器（停止播放）">✕</button>
      </div>
      <div class="av-stage">
        <div class="av-list"></div>
        <div class="av-error hidden"></div>
      </div>
      <audio class="av-audio" preload="metadata"></audio>
    </div>`;

    this.audio = this.q<HTMLAudioElement>(".av-audio")!;
    const audio = this.audio;

    this.ctx.host.querySelector(".av-bar")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
      if (!btn) return;
      switch (btn.dataset.act) {
        case "prev": void this.nav(-1); break;
        case "next": void this.nav(1); break;
        case "play": this.togglePlay(); break;
        case "mute": this.toggleMute(btn); break;
        case "loop": this.cycleLoop(btn); break;
        case "close": this.ctx?.closeView(); break;
      }
    });

    const rateSel = this.q<HTMLSelectElement>(".av-rate")!;
    rateSel.value = String(defaultRate);
    rateSel.addEventListener("change", () => {
      defaultRate = Number(rateSel.value) || 1;
      setPluginSetting(PID, "rate", defaultRate);
      if (this.audio) this.audio.playbackRate = defaultRate;
      this.syncStatus();
    });

    const volInput = this.q<HTMLInputElement>(".av-volume")!;
    volInput.value = String(volume);
    volInput.addEventListener("input", (e) => {
      volume = Number((e.target as HTMLInputElement).value);
      setPluginSetting(PID, "volume", volume);
      if (this.audio) this.audio.volume = volume;
      const muteBtn = this.q<HTMLElement>('button[data-act="mute"]');
      if (muteBtn) muteBtn.textContent = this.audio?.muted || volume === 0 ? "🔇" : "🔊";
    });

    audio.addEventListener("timeupdate", () => {
      const a = this.audio;
      if (!a || !this.ctx) return;
      if (!this.seeking && Number.isFinite(a.duration) && a.duration > 0 && this.mdProgress)
        this.mdProgress.value = String(Math.round((a.currentTime / a.duration) * 1000));
      if (this.mdCur) this.mdCur.textContent = fmtTime(a.currentTime);
      if (this.mdDur) this.mdDur.textContent = fmtTime(a.duration);
      if (!a.paused && Number.isFinite(a.duration) && a.duration > 0) {
        const slot = Math.floor(a.currentTime / 15);
        if (slot !== this.lastSlot) {
          this.lastSlot = slot;
          setPosition(this.currentPath, a.currentTime);
          persistPositions();
        }
      }
      this.syncStatus();
    });

    audio.addEventListener("loadedmetadata", () => {
      this.streamRetried.delete(this.currentPath); // 新一轮请求真拿到数据：恢复一次重试机会
      this.failStreak = 0; // 成功解码重置连败计数
      if (this.mdDur && this.audio) this.mdDur.textContent = fmtTime(this.audio.duration);
      this.syncStatus();
    });

    const syncPlayBtn = () => {
      const btn = this.q<HTMLElement>('button[data-act="play"]');
      if (btn && this.audio) btn.textContent = this.audio.paused ? "▶" : "⏸";
      if (this.mdPlay && this.audio) this.mdPlay.textContent = this.audio.paused ? "▶" : "⏸";
      mediaDock.refresh(); // 同步刷新迷你条播放态
      this.ctx?.setKeepAwake(this.isPlaying()); // 播放中保持常亮（幂等）
      this.renderList(); // ▶ 状态列跟随
      this.syncStatus();
    };
    audio.addEventListener("play", () => {
      // 单流策略：本视图开播时暂停其他播放中的音频视图（其 pause 事件自会刷新迷你条）
      for (const v of liveViews) if (v !== this) v.pauseIfPlaying();
      syncPlayBtn();
    });
    audio.addEventListener("pause", () => {
      if (this.audio && !this.audio.ended) this.saveCurrentPosition(); // ended 也发 pause：播完不记位置
      persistPositions();
      syncPlayBtn();
    });
    audio.addEventListener("ended", () => {
      syncPlayBtn();
      clearPosition(this.currentPath); // 播完的曲子重开从头播
      void this.nav(1, true);
    });
    audio.addEventListener("error", () => {
      // 流式失败（压缩 zip 条目、协议不可用、网络抖动）→ 原样重试一次，仍失败记忆并回退字节整读
      const p = this.currentPath;
      if (this.currentStream && this.audio && p && !this.streamFailed.has(p)) {
        if (!this.streamRetried.has(p)) {
          this.streamRetried.add(p);
          void this.loadTrack(p, !this.audio.paused);
          return;
        }
        this.streamFailed.add(p);
        void this.loadTrack(p, !this.audio.paused);
        return;
      }
      // 解码失败/文件失踪：标记 ⚠ 自动跳下一首；连败 3 首停止（防坏列表整张跑完）
      this.failStreak++;
      this.failed.add(p);
      this.renderList();
      this.showError(`无法播放：${baseName(p)}（编码不支持或文件失效）`);
      if (this.failStreak >= 3) {
        app.toast("连续 3 首播放失败，已停止自动跳曲");
        this.syncStatus();
        return;
      }
      void this.nav(1, true);
    });

    window.addEventListener("keydown", this.onKey);
  }

  private toggleMute(btn: HTMLElement): void {
    if (!this.audio) return;
    this.audio.muted = !this.audio.muted;
    btn.textContent = this.audio.muted || this.audio.volume === 0 ? "🔇" : "🔊";
  }

  /** 循环模式三态循环切换；单曲循环用 audio.loop 原生实现（ended 不触发） */
  private cycleLoop(btn: HTMLElement): void {
    loopMode = loopMode === "loop-list" ? "loop-one" : loopMode === "loop-one" ? "stop" : "loop-list";
    setPluginSetting(PID, "loopMode", loopMode);
    if (this.audio) this.audio.loop = loopMode === "loop-one";
    btn.textContent = LOOP_ICON[loopMode];
    btn.title = `循环模式：${LOOP_LABEL[loopMode]}`;
    app.toast(`循环模式：${LOOP_LABEL[loopMode]}`);
    this.syncStatus();
  }

  /** 媒体坞会话控件：完整控制行 + 迷你条扩展控件（⏮/⏭），由 dock 负责挂载/摘除 */
  private buildSession(): void {
    const el = document.createElement("div");
    el.className = "md-session";
    el.innerHTML = `
      <button class="md-play" title="播放/暂停（Space）">▶</button>
      <span class="md-cur">0:00</span>
      <input class="md-progress" type="range" min="0" max="1000" step="1" value="0" title="播放进度（←/→ 快退/快进 5 秒）" />
      <span class="md-dur">0:00</span>`;
    this.mdPlay = el.querySelector(".md-play");
    this.mdCur = el.querySelector(".md-cur");
    this.mdProgress = el.querySelector(".md-progress");
    this.mdDur = el.querySelector(".md-dur");
    this.mdPlay!.addEventListener("click", () => this.togglePlay());
    const progress = this.mdProgress!;
    progress.addEventListener("pointerdown", () => (this.seeking = true));
    progress.addEventListener("input", () => {
      const a = this.audio;
      if (a && Number.isFinite(a.duration) && a.duration > 0)
        a.currentTime = (Number(progress.value) / 1000) * a.duration;
    });
    progress.addEventListener("change", () => (this.seeking = false));
    progress.addEventListener("pointerup", () => (this.seeking = false));
    progress.addEventListener("lostpointercapture", () => (this.seeking = false)); // 双保险
    // 迷你条扩展控件：后台切曲（⏸/▶ 由迷你条自带）
    const mini = document.createElement("span");
    mini.className = "av-mini";
    const mprev = document.createElement("button");
    mprev.textContent = "⏮";
    mprev.title = "上一首";
    mprev.addEventListener("click", (e) => {
      e.stopPropagation(); // 不触发迷你条「跳回标签页」
      void this.nav(-1);
    });
    const mnext = document.createElement("button");
    mnext.textContent = "⏭";
    mnext.title = "下一首";
    mnext.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.nav(1);
    });
    mini.append(mprev, mnext);
    this.miniExtra = mini;
    this.sessionEl = el;
  }

  /* ========== 实例生命周期 ========== */

  open(c: PluginOpenContext): void {
    this.ctx = c;
    this.viewId = c.viewId;
    this.dirQueue = c.siblings.length > 0 ? [...c.siblings] : [c.path];
    this.queue = [...this.dirQueue];
    this.currentPath = this.dirQueue[Math.max(0, Math.min(c.siblingIndex, this.dirQueue.length - 1))] || c.path;
    this.buildView();
    this.buildSession();
    mediaDock.attach({
      id: c.viewId,
      kind: "audio",
      title: baseName(this.currentPath),
      element: this.sessionEl!,
      isPlaying: () => this.isPlaying(),
      miniExtra: this.miniExtra!,
    });
    liveViews.add(this);
    c.setKeepAwake(false); // 同实例换文件重开：重置常亮持有（play 事件会重新持有）
    this.renderList();
    void this.loadTrack(this.currentPath, true);
  }

  deactivate(): void {
    this.saveCurrentPosition(); // 关视图：落盘位置
    persistPositions();
    liveViews.delete(this);
    mediaDock.detach(this.viewId); // registry closeView 亦会 detach，此处幂等兜底
    this.sessionEl = null;
    this.mdPlay = null;
    this.mdCur = null;
    this.mdProgress = null;
    this.mdDur = null;
    this.miniExtra = null;
    window.removeEventListener("keydown", this.onKey);
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
    for (const u of this.urlCache.values()) URL.revokeObjectURL(u);
    this.urlCache.clear();
    this.streamFailed.clear();
    this.streamRetried.clear();
    this.failed.clear();
    this.currentStream = false;
    this.audio = null;
    this.ctx = null;
  }
}

/* ========== 插件定义 ========== */

export const audioViewerPlugin: ReadBookPlugin = {
  id: PID,
  name: "音频播放",
  version: "1.0.0",
  description:
    "播放常见音频格式（含 zip 内音频）：打开文件所在目录自动成队列连播、上一/下一首、倍速、音量、循环模式；切标签页与进托盘后台播放不中断（迷你条可控切曲）；2GB+ 大文件走宿主流式协议按需分块；支持多标签页多实例",
  extensions: EXTENSIONS,
  wantsStream: true,
  backgroundPlayback: true,
  createView: () => new AudioView(),
};
