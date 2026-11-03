/* 插件视图滚屏引擎（宿主能力，经 ctx.autoscroll 递入插件）：
   与文本阅读共用速度档（每帧现读 reader.getSpeed，加减速即时生效）；
   常亮、光标隐藏与状态栏"显示"格由引擎接管，滚到末尾自动停止并回调 onEnd。
   registry 按视图实例创建，视图关闭时停止解绑。 */
import { holdAwake } from "../keepawake";
import * as reader from "../reader";
import type { AutoscrollAttachOptions, PluginAutoscroll, PluginViewStatus } from "./types";

export function createAutoscroll(
  viewId: string,
  setStatus: (s: PluginViewStatus) => void
): PluginAutoscroll {
  let el: HTMLElement | null = null;
  let opts: AutoscrollAttachOptions = {};
  let scrolling = false;
  let rafId = 0;
  let lastTs = 0;
  let cursorTimer = 0;

  function atEnd(): boolean {
    if (!el) return true;
    const max = el.scrollHeight - el.clientHeight;
    return max <= 1 || el.scrollTop >= max - 1;
  }

  function loop(ts: number): void {
    if (!scrolling || !el) return;
    const dt = Math.min(100, ts - lastTs);
    lastTs = ts;
    el.scrollTop += (reader.getSpeed() * dt) / 1000;
    if (atEnd()) {
      stop();
      opts.onEnd?.();
      return;
    }
    rafId = requestAnimationFrame(loop);
  }

  /* 滚屏时移动鼠标短暂显示光标（与 reader 同款 1.2 秒手感） */
  function onMouseMove(): void {
    if (!scrolling || !el) return;
    el.classList.remove("scroll-hidden");
    window.clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(() => {
      if (scrolling && el) el.classList.add("scroll-hidden");
    }, 1200);
  }

  function start(): void {
    if (scrolling || !el) return;
    scrolling = true;
    holdAwake(`view:${viewId}`, true); // 与 ctx.setKeepAwake 同源（幂等），视图关闭宿主兜底释放
    el.classList.add("scroll-hidden");
    window.addEventListener("mousemove", onMouseMove);
    setStatus({ display: "滚屏中" });
    lastTs = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function stop(): void {
    if (!scrolling) return;
    scrolling = false;
    cancelAnimationFrame(rafId);
    window.clearTimeout(cursorTimer);
    window.removeEventListener("mousemove", onMouseMove);
    el?.classList.remove("scroll-hidden");
    holdAwake(`view:${viewId}`, false);
    setStatus({ display: "-" });
  }

  return {
    attach(target, o) {
      const was = scrolling;
      stop();
      el = target;
      opts = o ?? {};
      if (was) start();
    },
    detach() {
      stop();
      el = null;
      opts = {};
    },
    start,
    stop,
    toggle() {
      if (scrolling) stop();
      else start();
      return scrolling;
    },
    isScrolling: () => scrolling,
  };
}
