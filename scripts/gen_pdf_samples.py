# -*- coding: utf-8 -*-
"""T9 验收素材生成器：中文 CID 样本（豆腐块检查）与 500 页大样本（性能验收线）。

用法（仓库根执行；依赖 reportlab + Pillow(+numpy)：`pip install --user reportlab Pillow numpy`）：
  python3 scripts/gen_pdf_samples.py cid                 # 非嵌入 CID 中文字体样本，2 页约 5KB
  python3 scripts/gen_pdf_samples.py big                 # 500 页 / 50MB 量级大样本
  可选：--out DIR 指定输出目录；--font TTF 指定 big 用中文字体（否则自动探测，见下）
默认输出：<仓库根>/../examples/generated/（仓库外，样本不进版本控制），同名覆盖、可重复执行。

两个样本的用途：
  cid —— reportlab UnicodeCIDFont（STSong-Light=简体 UniGB-UCS2-H / MSung-Light=繁体
         UniCNS-UCS2-H，预定义 CMap、字体不嵌入）：插件未内联 cmaps 时 pdf.js 无法把
         CID 映射到 Unicode，渲染出豆腐块——红-绿断言的样本；内联后应无豆腐块。
  big —— 500 页 A4，每页唯一中文+英文正文（约 3000+ 字）+ 两幅程序生成 JPEG 图 +
         矢量装饰线，Droid Sans Fallback 字体嵌入（自带 cmap，不依赖插件 cmaps），
         内容流不压缩凑体积；用于滚动流畅/跳页即时/内存验收线。
"""
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# big 样本的中文嵌入字体探测候选（仅本机常见路径，--font 可显式指定）
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/droid/DroidSansFallback.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]


def default_output() -> Path:
    """默认输出目录：<仓库根>/../examples/generated（由脚本位置推导，仓库外不入版本控制）"""
    repo_root = Path(__file__).resolve().parent.parent  # scripts/ 的上级即仓库根
    return repo_root.parent / "examples" / "generated"


def find_cjk_font() -> Path:
    """探测可用的中文字体文件：常见路径逐一试探 → fontconfig fc-match 兜底；找不到即中文报错"""
    for p in FONT_CANDIDATES:
        if Path(p).is_file():
            return Path(p)
    fc = shutil.which("fc-match")
    if fc:
        try:
            out = subprocess.run([fc, "-f", "%{file}", "sans:lang=zh-cn"], capture_output=True, text=True, timeout=10)
            hit = out.stdout.strip()
            if hit and Path(hit).is_file() and hit.lower().endswith((".ttf", ".ttc", ".otf")):
                return Path(hit)
        except (OSError, subprocess.SubprocessError):
            pass
    raise SystemExit(
        "错误：未找到可嵌入的中文字体（gen_big 需要）。"
        "请用 --font /路径/字体.ttf 显式指定，或安装 fonts-droid-fallback / fonts-noto-cjk。"
    )

# 简繁中文词表（唯一正文原料：按页索引确定性取词，保证每页内容不同、可复跑一致）
ZH_WORDS = [
    "阅读器", "渲染", "文档", "章节", "滚动", "缩放", "字体", "映射", "段落", "页面",
    "性能", "内存", "缓存", "回收", "占位", "视口", "边界", "缓冲", "解析", "编码",
    "简体", "繁體", "字符", "宽度", "高度", "状态", "进度", "记忆", "恢复", "定位",
    "跳转", "导航", "工具栏", "快捷键", "自动滚屏", "连续", "流式", "远程", "网络", "本地",
    "文件", "目录", "书签", "历史", "外观", "主题", "颜色", "背景", "文本层", "选择",
    "复制", "摘录", "注记", "印章", "表单", "加密", "密码", "损坏", "截断", "错误",
    "提示", "状态栏", "页码", "总页数", "跳页", "即时", "渲染池", "并发", "队列", "调度",
    "引擎", "内核", "插件", "宿主", "注册", "扩展", "安装", "卸载", "升级", "兼容",
]
EN_WORDS = [
    "render", "viewport", "scroll", "zoom", "font", "glyph", "cmap", "mapping",
    "page", "canvas", "buffer", "cache", "memory", "decode", "parse", "stream",
    "plugin", "viewer", "document", "section", "progress", "restore", "layout",
    "measure", "budget", "threshold", "quantile", "latency", "throughput", "sample",
]


def unique_text(page_no: int, paragraphs: int) -> tuple[str, str]:
    """确定性生成第 page_no 页的唯一中文/英文正文（页间不重复，复跑结果一致）"""
    zh_parts: list[str] = []
    en_parts: list[str] = []
    k = page_no * 7
    for p in range(paragraphs):
        zh_words = [ZH_WORDS[(k + p * 3 + i * i + i) % len(ZH_WORDS)] for i in range(14)]
        en_words = [EN_WORDS[(k + p * 5 + i * 3) % len(EN_WORDS)] for i in range(10)]
        zh_parts.append(f"第{page_no}页段落{p + 1}：{'，'.join(zh_words)}。包含 English 混排如 {' '.join(en_words)}，用于检验中西文同页渲染与字体映射。")
        en_parts.append(f"Page {page_no} para {p + 1}: " + ", ".join(en_words) + ". Mixed content keeps every page unique for render benchmarks.")
    return "\n".join(zh_parts), "\n".join(en_parts)


def gen_page_image(page_no: int) -> "Image.Image":
    """程序生成第 page_no 页的唯一插图（确定性伪随机纹理+几何图形，JPEG 约 70~90KB，轻模糊后入库约 70KB。
    纯渐变会被 JPEG 压得极小，凑体积需高频细节——LCG 纹理确定性且跨页唯一）"""
    import numpy as np

    w, h = 800, 560
    # LCG 确定性纹理（种子含页码：页间唯一，复跑一致）。噪声在 1/4 分辨率生成再放大：
    # 高频细节让 JPEG 有真实体量，块状相关又不会像纯像素噪声那样把体积推到 3 位 MB
    nw, nh = w // 4, h // 4
    seeds = np.array([(page_no * 7919 + i * 104729) & 0xFFFFFFFF for i in range(3)], dtype=np.uint64)
    idx = np.arange(nw * nh, dtype=np.uint64)
    chans = []
    for s in seeds:
        x = (idx + s) * np.uint64(2654435761) + np.uint64(0x9E3779B9)
        x ^= x >> np.uint64(13)
        x = x * np.uint64(1274126177)
        x ^= x >> np.uint64(16)
        small = Image.frombytes("L", (nw, nh), (x & np.uint64(0xFF)).astype(np.uint8).tobytes())
        chans.append(small.resize((w, h), Image.NEAREST))
    img = Image.merge("RGB", chans)
    draw = ImageDraw.Draw(img)
    for i in range(9):  # 页专属圆环与色块（几何结构便于人工辨认页码内容）
        cx = 60 + (page_no * 13 + i * 89) % (w - 120)
        cy = 60 + (page_no * 29 + i * 53) % (h - 120)
        r = 16 + (page_no + i * 7) % 42
        draw.ellipse([cx - r, cy - r // 2, cx + r, cy + r // 2], outline=(255, (255 - 40 * i) % 256, 90), width=4)
        draw.rectangle([cx - r // 2, cy - r, cx + r // 2, cy + r], outline=((40 * i) % 256, 255, 120), width=3)
    return img


def gen_cid(out_dir: Path) -> None:
    """非嵌入 CID 中文字体样本（豆腐块红-绿断言素材）"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))  # 预定义 CMap UniGB-UCS2-H，不嵌字体
    pdfmetrics.registerFont(UnicodeCIDFont("MSung-Light"))  # UniCNS-UCS2-H（繁体）
    out = out_dir / "cid中文样本.pdf"
    c = canvas.Canvas(str(out), pagesize=A4)
    w, h = A4
    y = h - 72
    for line in [
        "中文渲染验收：非嵌入 CID 字体（STSong-Light，UniGB-UCS2-H 编码）。",
        "本页全部字形经预定义 CMap 把字符码映射到 CID，再映射到 Unicode；",
        "若阅读插件缺少对应 CMap 数据，画面将出现成排空心方框（豆腐块）。",
        "English inline: The lazy dog jumps over quick brown foxes, 0123456789.",
        "第二段验证多行结构：阅读器滚动、缩放、字体映射、段落重排均为常见路径，",
        "映射失败时这些路径全部退化为方框或空白，肉眼与像素检测都易判别。",
    ]:
        c.setFont("STSong-Light", 13)
        c.drawString(60, y, line)
        y -= 26
    c.showPage()
    y = h - 72
    for line in [
        "繁體驗收：非嵌入 CID 字體（MSung-Light，UniCNS-UCS2-H 編碼）。",
        "繁體字形走 UniCNS 系列預定義 CMap，覆蓋大五碼與 CNS 藏書常見用字；",
        "閱讀、縮放、目錄、章節、註記等路徑同樣依賴字碼映射的正確性。",
        "English inline: Traditional glyphs flow through the UniCNS collection, 9876543210.",
        "第三段：字形結構檢查以連通域為單位，方框與真實漢字的筆畫密度差異明顯。",
    ]:
        c.setFont("MSung-Light", 13)
        c.drawString(60, y, line)
        y -= 26
    c.showPage()
    c.save()
    raw = out.read_bytes()
    assert b"/FontFile" not in raw, "CID 样本不应嵌入字体程序（FontFile 出现即违背验收前提）"
    print(f"[cid] {out}（{len(raw)} 字节，非嵌入 CID：UniGB-UCS2-H + UniCNS-UCS2-H）")


def gen_big(out_dir: Path, pages: int = 500, font: Path | None = None) -> None:
    """500 页大样本（性能验收线素材）"""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    ttf = str(font) if font else str(find_cjk_font())
    print(f"[big] 嵌入字体：{ttf}")
    pdfmetrics.registerFont(TTFont("RbFallback", ttf))
    out = out_dir / "五百页大样本.pdf"
    w, h = A4
    c = canvas.Canvas(str(out), pagesize=A4, pageCompression=0)  # 内容流不压缩（体积诚实来自内容）
    for n in range(1, pages + 1):
        zh, en = unique_text(n, paragraphs=9)
        c.setFont("RbFallback", 16)
        c.drawString(56, h - 56, f"五百页大样本 · 第 {n} / {pages} 页")
        c.setFont("RbFallback", 10.5)
        y = h - 84
        for para in zh.split("\n"):
            for i in range(0, len(para), 46):
                c.drawString(56, y, para[i : i + 46])
                y -= 15
        y -= 8
        import io

        img = gen_page_image(n)
        img = img.filter(ImageFilter.GaussianBlur(2))  # 轻模糊：控制 JPEG 体量在 ~70KB
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=68)
        buf.seek(0)
        img = ImageReader(buf)
        c.drawImage(img, 76, y - 260, width=360, height=252)
        y -= 280
        c.setFont("RbFallback", 10)
        for para in en.split("\n"):
            for i in range(0, len(para), 92):
                c.drawString(56, y, para[i : i + 92])
                y -= 13
        # 矢量装饰线（每页唯一坐标，给解码/栅格化留真实工作量）
        for i in range(300):
            x0 = 300 + (n * 7 + i * 13) % 240
            y0 = 80 + (n * 3 + i * 29) % 600
            c.setStrokeColorRGB(((n + i) % 7) / 9, ((i + 1) % 5) / 7, ((n * i) % 6) / 8)
            c.line(x0, y0, x0 + 60 + i % 40, y0 + (i % 17) - 8)
        c.setFont("RbFallback", 9)
        c.drawRightString(w - 56, 40, f"- {n} -")
        c.showPage()
    c.save()
    size = out.stat().st_size
    print(f"[big] {out}（{pages} 页，{size / 1048576:.1f} MB）")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="PDF 插件验收素材生成器（cid=豆腐块样本 / big=500 页性能样本）")
    ap.add_argument("what", choices=["cid", "big"], help="cid=非嵌入 CID 中文样本；big=500 页大样本")
    ap.add_argument("--out", type=Path, default=default_output(), help=f"输出目录（默认 {default_output()}）")
    ap.add_argument("--font", type=Path, default=None, help="big 样本嵌入的中文字体（默认自动探测，cid 不需要）")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.what == "cid":
        gen_cid(args.out)
    else:
        gen_big(args.out, font=args.font)
