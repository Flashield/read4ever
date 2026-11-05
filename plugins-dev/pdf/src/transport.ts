/* 流式 Range 传输层：把 read4ever-stream:// 协议接进 pdf.js 自定义 range transport。
   pdf.js 契约（api.mjs PDFDataTransportStream）：一次 requestDataRange 必须一次性交付
   完整 [begin,end]——RangeReader 首个 _enqueue 即封口，分块拉取在本层凑满后才回调。
   disableAutoFetch 打开：阻止 pdf.js 后台渐进拉全文件，大文件内存不随体积线性增长。 */
import "./shims";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { fetchRange, probeTotalSize } from "./stream";
import { ensureWorker } from "./worker";
import { InlineBinaryDataFactory } from "./cmaps";

/** 首块 1MB：尽快出首页；与 rangeChunkSize 同值，初始数据恰按 chunk 边界对齐 */
export const RANGE_CHUNK = 1024 * 1024;

export class StreamRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  /** 已发起的 Range 网络请求数 / 已拉取字节数（只读自统计，供诊断与真机验证） */
  requests = 0;
  bytesFetched = 0;
  #onFatal: (() => void) | null = null;

  constructor(private url: string, total: number, initialData: Uint8Array) {
    super(total, initialData, false);
  }

  /** 加载中途网络失败时通知上层销毁加载任务（上层据此回退整读）；宿主销毁后置空 */
  setFatalHandler(fn: () => void): void {
    this.#onFatal = fn;
  }

  abort(): void {
    this.#onFatal = null; // pdf.js cancelAllRequests 途经此处：之后不再触发致命回调
  }

  requestDataRange(begin: number, end: number): void {
    this.requests++;
    void this.deliver(begin, end);
  }

  private async deliver(begin: number, end: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        // pdf.js 的 [begin, end) 为半开区间（内置 HTTP 流即 bytes=begin-(end-1)），fetchRange 收闭区间
        const chunk = await fetchRange(this.url, begin, end - 1);
        this.bytesFetched += chunk.length;
        this.onDataRange(begin, chunk);
        return;
      } catch {
        if (attempt >= 1) {
          this.#onFatal?.(); // 重试一次仍失败：交上层销毁任务（视图层回退整读或报错）
          return;
        }
      }
    }
  }
}

export interface StreamedStart {
  transport: StreamRangeTransport;
  task: PDFDocumentLoadingTask;
}

/** 流式打开（启动不等待）：bytes=0-0 探针取总长 → 首块 1MB 尽快出首页 → 自定义 transport
   交给 pdf.js。返回加载任务但**不 await promise**——调用方须先挂 onPassword 再 await
   （加密 PDF 的密码请求随解析异步到达，await 前挂回调即可接住）。探针失败（HTTP 非 206 /
   缺总长）直接抛错，调用方回退整读；加载中途网络失败经 fatal 回调销毁加载任务，表现为
   调用方 await promise 处拒绝 */
export async function startStreamed(url: string): Promise<StreamedStart> {
  const total = await probeTotalSize(url);
  const first = await fetchRange(url, 0, Math.min(RANGE_CHUNK, total) - 1);
  const transport = new StreamRangeTransport(url, total, first);
  ensureWorker();
  const task = pdfjsLib.getDocument({
    range: transport,
    rangeChunkSize: RANGE_CHUNK,
    disableAutoFetch: true,
    // 内联中文 CMaps 与整读路径共用（非嵌入 CID 中文字体不分数据路径）
    BinaryDataFactory: InlineBinaryDataFactory,
  });
  transport.setFatalHandler(() => void task.destroy().catch(() => {}));
  return { transport, task };
}
