/* 内联简繁中文 CMap（base64，构建脚本从 pdfjs-dist/cmaps 挑简繁系列打包，见
   scripts/build-plugins.mjs 的 preparePdfCmaps）：非嵌入 CID 中文字体（GBK/Big5/UniGB/
   UniCNS 等预定义编码）靠这些表把 CID 映射到 Unicode，缺失时整段文字渲染为空白/豆腐块。
   pdf.js 6.5 经 getDocument 的 BinaryDataFactory 取这些数据（旧版 CMapReaderFactory
   已废除）：worker 发 FetchBinaryData{kind:"cMapUrl", filename:"<名>.bcmap"} 回主线程，
   cMapPacked 默认 true → 返回二进制即按压缩表解码。整读（main.ts newFullReadTask）与
   流式（transport.ts startStreamed）两条 getDocument 路径都必须挂同一工厂——非嵌入
   CID 字体的文档无论哪条路都依赖 CMap。两调用点均无参构造：本工厂只供内联 cmap，
   其余 kind（standardFontDataUrl/wasmUrl）无数据可给，保持「即报错」语义（字体获取
   失败时 pdf.js 自行降级系统字体，standard_fonts 不随包分发）。 */
import cmapsJson from "../dist/cmaps.gen.txt?raw";

const CMAPS: Record<string, string> = JSON.parse(cmapsJson) as Record<string, string>;

function bytesFromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 从内联数据供表的 BinaryDataFactory：cmap 全走内联（零网络），同名缓存由 pdf.js 侧负责 */
export class InlineBinaryDataFactory {
  async fetch(arg: { kind: string; filename: string }): Promise<Uint8Array> {
    if (arg.kind !== "cMapUrl") throw new Error(`Ensure that the \`${arg.kind}\` API parameter is provided.`);
    const b64 = CMAPS[arg.filename.replace(/\.bcmap$/i, "")];
    if (b64 === undefined) throw new Error(`未内联的 CMap：${arg.filename}`);
    return bytesFromBase64(b64);
  }
}
