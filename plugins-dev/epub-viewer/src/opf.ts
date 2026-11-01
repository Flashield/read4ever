/* EPUB 结构解析：container.xml → OPF（manifest+spine）→ 目录（EPUB3 nav / EPUB2 NCX） */
import type { MiniZip } from "./minizip";

export interface TocEntry {
  label: string;
  href: string; // 解析后的 zip 条目路径（不含锚点）
  anchor: string; // #后锚点（可为空）
  depth: number;
}

export interface EpubBook {
  version: "2" | "3";
  title: string;
  /** spine 顺序的 XHTML 路径（已滤 linear="no"） */
  spine: string[];
  toc: TocEntry[];
  /** 全部样式表内容（书籍样式模式注入 shadow root） */
  cssText: string;
}

function parseXml(text: string, label: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`${label} 解析失败`);
  return doc;
}

function dirEntry(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

/** 拆锚点 + 相对路径解析（段式；epub 内路径无 zip 复合前缀） */
function resolveHref(dir: string, href: string): { path: string; anchor: string } {
  const si = href.indexOf("#");
  const anchor = si >= 0 ? href.slice(si + 1) : "";
  let raw = si >= 0 ? href.slice(0, si) : href;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* 已是原始字符：保持 */
  }
  const segs = dir ? dir.split(/[\\/]/).filter(Boolean) : [];
  for (const part of raw.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return { path: segs.join("/"), anchor };
}

export function parseEpub(zip: MiniZip): EpubBook {
  // container.xml → OPF 路径
  if (!zip.entries.has("META-INF/container.xml")) throw new Error("缺少 META-INF/container.xml");
  const cdoc = parseXml(zip.readText("META-INF/container.xml"), "container.xml");
  const opfPath = cdoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path") || "";
  if (!opfPath || !zip.entries.has(opfPath)) throw new Error(`OPF 不存在: ${opfPath}`);

  const odoc = parseXml(zip.readText(opfPath), "OPF");
  const verAttr = odoc.documentElement.getAttribute("version") || "2.0";
  const version: "2" | "3" = verAttr.startsWith("3") ? "3" : "2";
  const opfDir = dirEntry(opfPath);

  // manifest：id → 解析后 href
  const items = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const it of odoc.getElementsByTagName("item")) {
    const id = it.getAttribute("id") || "";
    const href = it.getAttribute("href") || "";
    if (!id || !href) continue;
    items.set(id, {
      href: resolveHref(opfDir, href).path,
      mediaType: it.getAttribute("media-type") || "",
      properties: it.getAttribute("properties") || "",
    });
  }

  // spine（滤 linear="no"）
  const spine: string[] = [];
  for (const ref of odoc.getElementsByTagName("itemref")) {
    if (ref.getAttribute("linear") === "no") continue;
    const href = items.get(ref.getAttribute("idref") || "")?.href;
    if (href && !spine.includes(href)) spine.push(href);
  }
  if (spine.length === 0) throw new Error("spine 为空");

  // 标题（dc:title）
  const title =
    [...odoc.getElementsByTagNameNS("*", "title")].map((t) => t.textContent?.trim() || "").find(Boolean) || "";

  // 目录：EPUB3 nav（properties 含 nav）优先，回退 EPUB2 NCX
  const toc: TocEntry[] = [];
  const navItem = [...items.values()].find((i) => i.properties.split(/\s+/).includes("nav"));
  if (navItem && zip.entries.has(navItem.href)) {
    const ndoc = parseXml(zip.readText(navItem.href), "nav.xhtml");
    const navDir = dirEntry(navItem.href);
    const navs = [...ndoc.getElementsByTagName("nav")];
    const tocNav =
      navs.find(
        (n) =>
          n.getAttribute("epub:type") === "toc" ||
          n.getAttributeNS("http://www.idpf.org/2007/ops", "type") === "toc"
      ) || navs[0];
    const walk = (ol: Element, depth: number): void => {
      for (const li of ol.children) {
        if (li.tagName.toLowerCase() !== "li") continue;
        const a = li.querySelector("a[href]");
        if (a) {
          const { path, anchor } = resolveHref(navDir, a.getAttribute("href") || "");
          toc.push({ label: a.textContent?.trim() || "(无标题)", href: path, anchor, depth });
        }
        const sub = li.querySelector(":scope > ol");
        if (sub) walk(sub as Element, depth + 1);
      }
    };
    const rootOl = tocNav?.querySelector("ol");
    if (rootOl) walk(rootOl as Element, 0);
  }
  if (toc.length === 0) {
    // NCX 回退（EPUB2；EPUB3 书也可带）
    const spineEl = odoc.getElementsByTagName("spine")[0];
    const ncxId = spineEl?.getAttribute("toc") || "";
    const ncxHref =
      (ncxId && items.get(ncxId)?.href) ||
      [...items.values()].find((i) => i.mediaType === "application/x-dtbncx+xml")?.href;
    if (ncxHref && zip.entries.has(ncxHref)) {
      const ndoc = parseXml(zip.readText(ncxHref), "NCX");
      const ncxDir = dirEntry(ncxHref);
      const walk = (parent: Element, depth: number): void => {
        for (const np of parent.children) {
          if (np.tagName.toLowerCase() !== "navpoint") continue;
          const label = np.getElementsByTagName("text")[0]?.textContent?.trim() || "";
          const src = np.getElementsByTagName("content")[0]?.getAttribute("src") || "";
          if (src) {
            const { path, anchor } = resolveHref(ncxDir, src);
            toc.push({ label: label || "(无标题)", href: path, anchor, depth });
          }
          walk(np, depth + 1);
        }
      };
      const navMap = ndoc.getElementsByTagName("navMap")[0] || ndoc.documentElement;
      walk(navMap, 0);
    }
  }
  if (toc.length === 0) {
    // 兜底：按 spine 生成占位目录
    spine.forEach((href, i) => toc.push({ label: `第 ${i + 1} 节`, href, anchor: "", depth: 0 }));
  }

  // 样式表：全部 text/css 条目合并（shadow root 内生效，互不污染宿主）
  let cssText = "";
  for (const it of items.values()) {
    if (it.mediaType === "text/css" && zip.entries.has(it.href)) {
      try {
        cssText += zip.readText(it.href) + "\n";
      } catch {
        /* 单个 css 读失败不阻塞 */
      }
    }
  }

  return { version, title, spine, toc, cssText };
}
