/* 【临时调试】性能探针：定位"打开大文件后菜单/侧边栏卡顿"。定位完成后整个文件删除。
   已确认：卡顿 = 单个最长 37s 的主线程长任务，CPU 低，任务内无渲染工作
   → 主线程在等某个进程外的同步调用。本版聚焦：
   ① 事件生命周期拆分（排队/处理/处理后到绘制——判断冻结发生在哪一段）
   ② 输入与焦点的派发时刻线（判断冻结起点相对哪个事件）
   ③ 长动画帧里的脚本来源定位 */

const log: string[] = [];
let t0 = 0;

function ts(): string {
  return `+${((performance.now() - t0) / 1000).toFixed(2)}s`;
}

/** 记录一条性能日志（同时进 console 与内存环形缓冲） */
export function perfLine(s: string): void {
  const line = `[perf ${ts()}] ${s}`;
  log.push(line);
  if (log.length > 800) log.shift();
  console.log(line);
}

const num = (v: number): number => (Number.isFinite(v) ? Math.round(v) : 0);

function describe(t: EventTarget | null): string {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return String(t);
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : "";
  const txt = el.children.length === 0 ? `"${(el.textContent || "").slice(0, 8)}"` : "";
  return `${el.tagName}${id}${cls}${txt}`;
}

export function initDebugPerf(): void {
  t0 = performance.now();
  perfLine(`探针启动 UA=${navigator.userAgent.slice(0, 80)}`);

  /* 1. 长任务：主线程单次 >50ms 的任务 */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perfLine(`长任务 ${Math.round(e.duration)}ms`);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    perfLine("longtask 不可用");
  }

  /* 2. 长动画帧：脚本/样式布局细分 + 脚本来源（文件:行(函数)） */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const f = e as unknown as {
          duration: number; startTime: number; renderStart: number; styleAndLayoutStart: number;
          scripts: Record<string, unknown>[];
        };
        const rendering = f.renderStart > 0 ? f.duration - (f.renderStart - f.startTime) : 0;
        const styleLayout = f.styleAndLayoutStart > 0 ? rendering - (f.styleAndLayoutStart - f.renderStart) : 0;
        const top = [...(f.scripts ?? [])]
          .sort((a, b) => num(b.duration as number) - num(a.duration as number))
          .slice(0, 2)
          .map((s) => {
            const url = String(s.sourceURL ?? "").split(/[\\/]/).pop() ?? "?";
            const fn = String(s.sourceFunctionName ?? "");
            const at = `${url}:${s.sourceLineNumber ?? "?"}${fn ? `(${fn})` : ""}`;
            const extra = num(s.forcedStyleAndLayoutDuration as number) > 1 ? `(强制重排 ${num(s.forcedStyleAndLayoutDuration as number)}ms)` : "";
            return `${at} ${num(s.duration as number)}ms${extra}`;
          })
          .join(" | ");
        perfLine(`长动画帧 ${Math.round(f.duration)}ms（渲染 ${Math.round(rendering)}ms / 样式布局 ${Math.round(styleLayout)}ms）${top ? " ← " + top : ""}`);
      }
    }).observe({ entryTypes: ["long-animation-frame"] });
  } catch {
    perfLine("长动画帧不可用");
  }

  /* 3. 事件生命周期：排队 → 处理 → 处理后到绘制（"处理后到绘制"大 = 冻结在 JS 之后、上屏之前） */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const ev = e as PerformanceEventTiming;
        const queue = num(ev.processingStart - ev.startTime);
        const handle = num(ev.processingEnd - ev.processingStart);
        const toPaint = num(ev.duration - (ev.processingEnd - ev.startTime));
        perfLine(`事件 ${ev.name}: 排队 ${queue}ms → 处理 ${handle}ms → 处理后到绘制 ${toPaint}ms（总 ${Math.round(ev.duration)}ms）`);
      }
    }).observe({ type: "event", durationThreshold: 50 } as PerformanceObserverInit);
  } catch {
    perfLine("event 不可用");
  }

  /* 4. 派发与焦点时刻线：冻结起点相对哪个事件 */
  for (const type of ["pointerdown", "click", "keydown", "focusin", "focusout"]) {
    document.addEventListener(
      type,
      (e) => perfLine(`→ ${type} @ ${describe(e.target)}`),
      true
    );
  }

  (window as unknown as { __rbPerf: object }).__rbPerf = {
    dump: () => console.log(log.join("\n")),
    log,
  };
}
