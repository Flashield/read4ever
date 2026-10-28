/* 浏览器演示后端：无 Tauri 环境（__TAURI_INTERNALS__ 不存在）时启用，
   便于 npm run dev 直接在浏览器中预览与调试 UI。生产环境不会加载本文件。 */

type InvokeArgs = Record<string, unknown>;

const DEMO_BOOKS: Record<string, { name: string; content: string }> = {
  "C:\\demo\\西游记选段.txt": {
    name: "西游记选段.txt",
    content:
      "第一回 灵根育孕源流出 心性修持大道生\n" +
      "&quot;诗曰&quot;：混沌未分天地乱，茫茫渺渺无人见。&nbsp;\n" +
      "自从盘古破鸿蒙，开辟从兹清浊辨。\n" +
      "覆载群生仰至仁，发明万物皆成善。\n" +
      "欲知造化会元功，须看西游释厄传。\n" +
      "\n" +
      "盖闻天地之数，有十二万九千六百岁为一元。\n" +
      "将一元分为十二会，乃子、丑、寅、卯、辰、巳、\n" +
      "午、未、申、酉、戌、亥之十二支也。\n" +
      "每会该一万八百岁。\n" +
      "\n" +
      "且说那座山，名唤花果山。\n" +
      "此山乃十洲之祖脉，三岛之来龙，\n" +
      "自开清浊而立，鸿蒙判后而成。\n" +
      "真个好山！有词赋为证。\n" +
      "\n" +
      "势镇汪洋，威宁瑶海。\n" +
      "势镇汪洋，潮涌银山鱼入穴；\n" +
      "威宁瑶海，波翻雪浪蜃离渊。\n" +
      "\n" +
      "那猴在山中，却会行走跳跃，食草木，饮涧泉，\n" +
      "采山花，觅树果；与狼虫为伴，虎豹为群，\n" +
      "獐鹿为友，猕猿为亲；夜宿石崖之下，\n" +
      "朝游峰洞之中。真是山中无甲子，寒尽不知年。",
  },
  "C:\\demo\\鲁迅杂文.txt": {
    name: "鲁迅杂文.txt",
    content:
      "秋夜\n" +
      "\n" +
      "在我的后园，可以看见墙外有两株树，\n" +
      "一株是枣树，还有一株也是枣树。\n" +
      "\n" +
      "这上面的夜的天空，奇怪而高，\n" +
      "我生平没有见过这样的奇怪而高的天空。\n" +
      "他仿佛要离开人间而去，使人们仰面不再看见。\n" +
      "然而现在却非常之蓝，闪闪地䀹着几十个星星的眼，\n" +
      "冷眼。他的口角上现出微笑，似乎自以为大有深意，\n" +
      "而将繁霜洒在我的园里的野花草上。\n" +
      "\n" +
      "我不知道那些花草真叫什么名字，\n" +
      "人们叫他们什么名字。\n" +
      "我记得有一种开过极细小的粉红花，\n" +
      "现在还开着，但是更极细小了，\n" +
      "她在冷的夜气中，瑟缩地做梦，\n" +
      "梦见春的到来，梦见秋的到来，\n" +
      "梦见瘦的诗人将眼泪擦在她最末的花瓣上，\n" +
      "告诉她秋虽然来，冬虽然来，\n" +
      "而此后接着还是春，蝴蝶乱飞，蜜蜂都唱起春词来了。",
  },
  "C:\\demo\\传统小说.txt": {
    name: "传统小说.txt",
    content:
      "话说天下大势，分久必合，合久必分。\n" +
      "周末七国分争，并入于秦。\n" +
      "及秦灭之后，楚、汉分争，又并入于汉。\n" +
      "汉朝自高祖斩白蛇而起义，一统天下，\n" +
      "后来光武中兴，传至献帝，遂分为三国。\n" +
      "\n" +
      "推其致乱之由，殆始于桓、灵二帝。\n" +
      "桓帝禁锢善类，崇信宦官。\n" +
      "及桓帝崩，灵帝即位，大将军窦武、太傅陈蕃，\n" +
      "共相辅佐。时有宦官曹节等弄权，\n" +
      "窦武、陈蕃谋诛之，机事不密，反为所害。\n" +
      "中涓自此愈横。",
  },
  "C:\\demo\\长行测试.txt": {
    name: "长行测试.txt",
    content:
      "这是一段很长的正文内容用来测试索引条目在行宽不足时的表现情况。关键词是目标词在中间。\n".repeat(60),
  },
};

const ZIP_PATH = "C:\\demo\\西游记合集.zip";
const ZIP_ENTRIES = [
  "小说/西游记上卷.txt",
  "小说/西游记下卷.txt",
  "插画/插图01.png",
  "插画/插图02.png",
  "视频/演示A.mp4",
  "视频/演示B.mp4",
];

/* ========== 演示图片（canvas 现画现用，供图片查看插件测试） ========== */

function makeDemoPngDataUrl(color: string, label: string, w = 480, h = 300): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "#222");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#fff";
  g.font = "30px sans-serif";
  g.fillText(label, 24, 64);
  return c.toDataURL("image/png");
}

function dataUrlToBuffer(url: string): ArrayBuffer {
  const b64 = url.split(",")[1];
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer as ArrayBuffer;
}

const COVER_PNG = makeDemoPngDataUrl("#5a8f3c", "封面图片（演示）");
const ILLUSTRATION_1 = makeDemoPngDataUrl("#2b6cb0", "插图 01（演示）");
const ILLUSTRATION_2 = makeDemoPngDataUrl("#b0562b", "插图 02（演示）");
const GROUP_A1 = makeDemoPngDataUrl("#6b2bb0", "第一组 图 A（横）", 480, 300);
const GROUP_A2 = makeDemoPngDataUrl("#b02b8f", "第一组 图 B（竖）", 300, 480);
const GROUP_B1 = makeDemoPngDataUrl("#2b8fb0", "第二组 图 C（横）", 480, 300);
// 竖版窄图组：横向（从左至右/从右至左）滚屏演示——适高后单帧宽度小于视口，可同时看到多张
const GROUP_P1 = makeDemoPngDataUrl("#8f2b2b", "竖图 P1", 200, 480);
const GROUP_P2 = makeDemoPngDataUrl("#8f6e2b", "竖图 P2", 200, 480);
const GROUP_P3 = makeDemoPngDataUrl("#7a8f2b", "竖图 P3", 200, 480);
const GROUP_P4 = makeDemoPngDataUrl("#2b8f2b", "竖图 P4", 200, 480);
const GROUP_P5 = makeDemoPngDataUrl("#2b8f6e", "竖图 P5", 200, 480);
const GROUP_P6 = makeDemoPngDataUrl("#2b8f8f", "竖图 P6", 200, 480);
const GROUP_P7 = makeDemoPngDataUrl("#2b6e8f", "竖图 P7", 200, 480);
const GROUP_P8 = makeDemoPngDataUrl("#2b2b8f", "竖图 P8", 200, 480);

/* ========== 演示视频（ffmpeg 生成的小段 mp4，供视频查看插件测试） ========== */

const DEMO_VIDEO_A = "data:video/mp4;base64,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";
const DEMO_VIDEO_B = "data:video/mp4;base64,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";

/* ========== 演示外部插件（走完整外部链路：list → read main.js → blob import → register） ========== */

const DEMO_PLUGIN_PKG = {
  id: "hex-viewer",
  name: "十六进制查看",
  version: "1.0.0",
  description: "演示外部插件：以十六进制 + ASCII 对照查看文件前 4KB",
  author: "ReadBook 演示",
  api: 1,
  entry: "main.js",
  extensions: [".hex", ".bin"],
  dir: "(浏览器演示内置)",
};

const DEMO_PLUGIN_JS = `/* 演示外部插件：十六进制查看器 */
export default {
  id: "hex-viewer",
  name: "十六进制查看",
  version: "1.0.0",
  description: "演示外部插件：以十六进制 + ASCII 对照查看文件前 4KB",
  extensions: [".hex", ".bin"],
  open(ctx) {
    const b = ctx.bytes;
    const shown = Math.min(b.length, 4096);
    const lines = [];
    for (let i = 0; i < shown; i += 16) {
      const chunk = Array.from(b.slice(i, Math.min(i + 16, shown)));
      const hex = chunk.map((x) => x.toString(16).padStart(2, "0")).join(" ");
      const asc = chunk.map((x) => (x >= 32 && x < 127) ? String.fromCharCode(x) : "·").join("");
      lines.push(i.toString(16).padStart(8, "0") + "  " + hex + "  " + asc);
    }
    const pre = document.createElement("pre");
    pre.style.cssText = "margin:12px;padding:8px;font:12px/1.7 Consolas,monospace;white-space:pre;overflow:auto";
    pre.textContent = lines.join("\\n") || "(空文件)";
    ctx.host.style.overflow = "auto";
    ctx.host.appendChild(pre);
    ctx.setStatus({
      title: ctx.name,
      encoding: "字节 " + b.length,
      position: "显示前 " + shown + " 字节",
      mode: "模式: 十六进制",
      display: "外部插件演示",
    });
  },
};
`;

/* ========== 内存虚拟文件系统（文件夹侧栏演示） ========== */

type MockFsNode = { dir: true; children: Map<string, MockFsNode> } | { dir: false; content: string; mtime: number };

const MOCK_FOLDER = "C:\\demo\\书库";
const MOCK_MTIME = Date.now();

const mockDir = (children: Record<string, MockFsNode> = {}): MockFsNode => ({
  dir: true,
  children: new Map(Object.entries(children)),
});
const mockFile = (content: string): MockFsNode => ({ dir: false, content, mtime: MOCK_MTIME });
const demoText = (key: keyof typeof DEMO_BOOKS): string => DEMO_BOOKS[key].content;

const mockFsRoot: MockFsNode = mockDir({
  "西游记选段.txt": mockFile(demoText("C:\\demo\\西游记选段.txt")),
  "鲁迅杂文.txt": mockFile(demoText("C:\\demo\\鲁迅杂文.txt")),
  "传统": mockDir({ "传统小说.txt": mockFile(demoText("C:\\demo\\传统小说.txt")) }),
  "未归类": mockDir({}),
  "01组": mockDir({
    "图A.png": mockFile(GROUP_A1),
    "图B.png": mockFile(GROUP_A2),
  }),
  "02组": mockDir({ "图C.png": mockFile(GROUP_B1) }),
  "03组": mockDir({
    "竖图P1.png": mockFile(GROUP_P1),
    "竖图P2.png": mockFile(GROUP_P2),
    "竖图P3.png": mockFile(GROUP_P3),
    "竖图P4.png": mockFile(GROUP_P4),
    "竖图P5.png": mockFile(GROUP_P5),
    "竖图P6.png": mockFile(GROUP_P6),
    "竖图P7.png": mockFile(GROUP_P7),
    "竖图P8.png": mockFile(GROUP_P8),
  }),
  "封面图片.png": mockFile(COVER_PNG),
  "示例视频A.mp4": mockFile(DEMO_VIDEO_A),
  "示例视频B.mp4": mockFile(DEMO_VIDEO_B),
  "示例数据.hex": mockFile(
    "ReadBook external plugin demo.\nThis plain-text file is shown by the demo\nhex-viewer plugin, loaded through the full\nexternal plugin pipeline (manifest -> main.js -> blob import).\n"
  ),
});

const fsJoin = (dir: string, name: string): string => dir.replace(/[\\/]+$/, "") + "\\" + name;

function fsParts(p: string): string[] {
  const norm = p.replace(/\//g, "\\");
  const rel = norm.startsWith(MOCK_FOLDER) ? norm.slice(MOCK_FOLDER.length) : norm;
  return rel.split("\\").filter(Boolean);
}

function fsGet(p: string): MockFsNode | null {
  let node: MockFsNode = mockFsRoot;
  for (const part of fsParts(p)) {
    if (!node.dir) return null;
    const next = node.children.get(part);
    if (!next) return null;
    node = next;
  }
  return node;
}

function fsParentOf(p: string): { dir: Extract<MockFsNode, { dir: true }>; name: string; dirPath: string } | null {
  const parts = fsParts(p);
  const name = parts.pop();
  if (!name) return null;
  const dirPath = MOCK_FOLDER + (parts.length ? "\\" + parts.join("\\") : "");
  const parent = fsGet(dirPath);
  return parent && parent.dir ? { dir: parent, name, dirPath } : null;
}

/* ========== 演示 SMB 服务器（远程面板用；路径用 "/" 分隔） ========== */

const SMB_DEMO_SERVER = { id: "demo", name: "演示 NAS", host: "192.168.1.100", share: "books", workgroup: "", username: "", password: "" };
/* 已注册服务器（smb_put_servers 保存；share 用于服务器根 smb://<id> 列目录时补规范前缀） */
let smbServers: Array<{ id: string; share: string }> = [SMB_DEMO_SERVER];
const smbFsRoot: MockFsNode = mockDir({
  "第1章.txt": mockFile(
    "第一章 远方的信号\n\n陈默在整理旧书时，发现夹在书页间的一张字条。\n字条上只有一行钢笔字：坐标在北方，落款在雨夜。\n他决定按图索骥。\n"
  ),
  "第2章.txt": mockFile(
    "第二章 旧城的钥匙\n\n钥匙藏在邮局第三格抽屉里。\n抽屉里还有一封没有寄出的信，收信人是三十年前的他自己。\n"
  ),
  "第3章.txt": mockFile(
    "第三章 未寄出的信\n\n信的开头写着：如果你读到这里，说明雨已经停了。\n陈默望向窗外，雨确实停了。\n"
  ),
  "西游记选段.txt": mockFile(demoText("C:\\demo\\西游记选段.txt")),
  "传统小说.txt": mockFile(demoText("C:\\demo\\传统小说.txt")),
  "西游记合集.zip": mockFile("(演示 zip 内容)"),
  ".DS_Store": mockFile(""), // 隐藏项：列表应跳过
});

function smbParts(p: string): string[] {
  const norm = p.replace(/\\/g, "/");
  if (!norm.startsWith("smb://")) return norm.split("/").filter(Boolean);
  // 与后端 resolve 一致：剥掉 smb://<id>[/<share>] 前缀（服务器根别名与规范路径都指向 share 根）
  const segs = norm.slice("smb://".length).split("/").filter(Boolean);
  return segs.slice(Math.min(2, segs.length)).filter(Boolean);
}

function smbGet(p: string): MockFsNode | null {
  let node: MockFsNode = smbFsRoot;
  for (const part of smbParts(p)) {
    if (!node.dir) return null;
    const next = node.children.get(part);
    if (!next) return null;
    node = next;
  }
  return node;
}

/* 演示缓存状态（smb_cache_file 置位，smb_clear_cache 清空） */
const smbCached = new Set<string>();

/* 智能序号排序（同前缀按数字）：第2章 排在 第10章 之前 */
function mockSeqSort(a: string, b: string): number {
  const na = /^(\D*)(\d+)/.exec(a);
  const nb = /^(\D*)(\d+)/.exec(b);
  if (na && nb && na[1].toLowerCase() === nb[1].toLowerCase()) {
    return Number(na[2]) - Number(nb[2]);
  }
  return a.localeCompare(b);
}

function mockSmbList(p: string): Record<string, unknown>[] | null {
  const node = smbGet(p);
  if (!node || !node.dir) return null;
  let parent = p.replace(/\/+$/, "");
  // 服务器根别名 smb://<id> → 补 share 段成规范路径（与后端 list_dir 一致）
  const segs = parent.split("/").filter(Boolean);
  if (segs.length === 2) {
    const srv = smbServers.find((s) => s.id === segs[1]);
    parent = `smb://${segs[1]}/${srv ? srv.share : "books"}`;
  }
  const entries = [...node.children.entries()]
    .filter(([name]) => !name.startsWith("."))
    .map(([name, child]) => ({
      name,
      path: `${parent}/${name}`,
      isDir: child.dir,
      size: child.dir ? 0 : child.content.length,
      mtime: child.dir ? 0 : child.mtime,
      cached: !child.dir && smbCached.has(`${parent}/${name}`),
    }));
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return entries;
}

let dialogCounter = 0;
const storeData = {
  settings: {
    themeName: "羊皮纸",
    customThemes: [],
    fontFamily: "SimSun",
    fontSize: 18,
    lineSpacing: 1.8,
    scrollSpeed: 3,
    scrollMode: "continuous",
    pageInterval: 10,
    displayMode: "auto",
    dualPage: false,
    lastFilePath: "",
    lastScroll: 0,
    autoRestore: false,
    folderTab: "",
  },
  bookmarks: [],
  history: [],
  bookshelves: [{ id: "shelf-default", name: "默认书架", items: [] }],
  keywordGroups: [],
  smbServers: [SMB_DEMO_SERVER],
};

function demoContent(path: string): Record<string, unknown> {
  let book = DEMO_BOOKS[path];
  let fileName = path.split(/[\\/]/).pop() || "";
  if (path.includes("::")) {
    const entry = path.split("::")[1];
    fileName = entry.split("/").pop() || entry;
    book = DEMO_BOOKS["C:\\demo\\西游记选段.txt"];
  }
  if (!book) {
    const base = fileName.toLowerCase();
    for (const k of Object.keys(DEMO_BOOKS)) {
      if (k.toLowerCase().endsWith("\\" + base)) {
        book = DEMO_BOOKS[k];
        break;
      }
    }
  }
  if (!book) book = DEMO_BOOKS["C:\\demo\\西游记选段.txt"];
  const content = book.content;
  return {
    content,
    encoding: "UTF-8",
    fileName,
    filePath: path,
    isHardLines: true,
  };
}

function reorderText(text: string): string {
  return text
    .split(/\n/)
    .reduce((acc: string[], line) => {
      const prev = acc[acc.length - 1];
      if (prev !== undefined && prev !== "" && line !== "" && !/[。！？”"』]+$/.test(prev)) {
        acc[acc.length - 1] = prev + line;
      } else {
        acc.push(line);
      }
      return acc;
    }, [])
    .join("\n");
}

const callbacks: Record<number, (data: unknown) => void> = {};
let cbId = 100;

/* @ts-expect-error 扩展 window：标记演示模式（fullscreen.ts 据此走网页全屏而非原生窗口全屏） */
window.__RB_BROWSER_DEMO__ = true;
/* @ts-expect-error 扩展 window */
window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main", windowLabel: "main" },
  },
  transformCallback(cb: (data: unknown) => void) {
    const id = cbId++;
    callbacks[id] = cb;
    return id;
  },
  invoke(cmd: string, args: InvokeArgs = {}): Promise<unknown> {
    switch (cmd) {
      case "load_store":
        return Promise.resolve(JSON.parse(JSON.stringify(storeData)));
      case "save_store":
        Object.assign(storeData, args.data);
        return Promise.resolve(null);
      case "set_window_title":
        document.title = String(args.title ?? "ReadBook");
        return Promise.resolve(null);
      case "hide_to_tray":
      case "show_from_tray":
      case "exit_app":
      case "set_keep_awake":
        console.log(`[mock] ${cmd}`);
        return Promise.resolve(null);
      case "open_text_file": {
        const p = String(args.path);
        if (p.endsWith(".zip")) return Promise.reject("这是一个 zip 文件");
        if (p.startsWith("smb://")) {
          const node = smbGet(p);
          if (!node || node.dir) return Promise.reject("无法打开远程文件: " + p);
          return Promise.resolve({
            content: (node as { dir: false; content: string }).content,
            encoding: "UTF-8",
            fileName: p.split("/").pop() || "",
            filePath: p,
            isHardLines: true,
          });
        }
        return Promise.resolve(demoContent(p));
      }
      case "open_zip_file":
        return Promise.resolve(ZIP_ENTRIES);
      case "read_zip_entry":
        return Promise.resolve(demoContent(`${args.path}::${args.entryName}`));
      case "save_text_file":
      case "edit_save":
        console.log(`[mock] ${cmd}`, args.path, args.encoding);
        return Promise.resolve(null);
      case "reorder":
        return Promise.resolve(reorderText(String(args.content)));
      case "find_next":
      case "find_prev": {
        const p = String(args.path);
        if (p.startsWith("smb://")) {
          const slash = p.lastIndexOf("/");
          const dir = p.slice(0, slash);
          const cur = p.slice(slash + 1);
          const node = smbGet(dir);
          if (!node || !node.dir || !cur) return Promise.resolve(null);
          const ext = (cur.split(".").pop() || "txt").toLowerCase();
          const names = [...node.children.keys()]
            .filter((n) => {
              const child = node.children.get(n)!;
              return !child.dir && (n.split(".").pop() || "txt").toLowerCase() === ext;
            })
            .sort(mockSeqSort);
          const i = names.indexOf(cur);
          if (cmd === "find_next") {
            const next = i >= 0 ? names[i + 1] : names[0];
            return Promise.resolve(next ? `${dir}/${next}` : null);
          }
          if (i <= 0) return Promise.resolve(null);
          return Promise.resolve(`${dir}/${names[i - 1]}`);
        }
        return Promise.resolve(null);
      }
      case "list_dir":
      case "smb_list_dir": {
        const p = String(args.path);
        if (p.startsWith("smb://")) {
          const list = mockSmbList(p);
          if (!list) return Promise.reject("无法读取远程目录: " + p);
          return Promise.resolve(list);
        }
        if (cmd === "smb_list_dir") return Promise.reject("不是 SMB 路径: " + p);
        const node = fsGet(p);
        if (!node || !node.dir) return Promise.reject("无法读取目录: " + p);
        const entries = [...node.children.entries()].map(([name, child]) => ({
          name,
          path: fsJoin(p, name),
          isDir: child.dir,
          size: child.dir ? 0 : child.content.length,
          mtime: child.dir ? 0 : child.mtime,
        }));
        entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return Promise.resolve(entries);
      }
      case "trash_path": {
        const parent = fsParentOf(String(args.path));
        if (!parent || !parent.dir.children.has(parent.name)) return Promise.reject("未找到: " + args.path);
        parent.dir.children.delete(parent.name);
        return Promise.resolve(null);
      }
      case "move_path": {
        const parent = fsParentOf(String(args.from));
        const node = fsGet(String(args.from));
        const dest = fsGet(String(args.toDir));
        if (!parent || !node || !dest || !dest.dir) return Promise.reject("移动失败");
        parent.dir.children.delete(parent.name);
        let name = parent.name;
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let i = 1;
        while (dest.children.has(name)) name = `${stem}(${i++})${ext}`;
        dest.children.set(name, node);
        return Promise.resolve(fsJoin(String(args.toDir), name));
      }
      case "rename_path": {
        const parent = fsParentOf(String(args.from));
        const node = fsGet(String(args.from));
        const newName = String(args.newName).trim();
        if (!parent || !node || !newName || parent.dir.children.has(newName)) {
          return Promise.reject("重命名失败");
        }
        parent.dir.children.delete(parent.name);
        parent.dir.children.set(newName, node);
        return Promise.resolve(fsJoin(parent.dirPath, newName));
      }
      case "read_file_bytes": {
        const p = String(args.path);
        if (p.startsWith("smb://")) {
          const node = smbGet(p);
          if (!node || node.dir) return Promise.reject("读取失败: " + p);
          const c = (node as { dir: false; content: string }).content;
          return Promise.resolve(
            c.startsWith("data:")
              ? dataUrlToBuffer(c)
              : (new TextEncoder().encode(c).buffer as ArrayBuffer)
          );
        }
        const node = fsGet(p);
        if (!node || node.dir) return Promise.reject("读取失败: " + p);
        const content = (node as { dir: false; content: string }).content;
        if (content.startsWith("data:")) return Promise.resolve(dataUrlToBuffer(content));
        return Promise.resolve(new TextEncoder().encode(content).buffer as ArrayBuffer);
      }
      case "read_zip_entry_bytes": {
        const entry = String(args.entryName);
        if (entry.endsWith("插图01.png")) return Promise.resolve(dataUrlToBuffer(ILLUSTRATION_1));
        if (entry.endsWith("插图02.png")) return Promise.resolve(dataUrlToBuffer(ILLUSTRATION_2));
        if (entry.endsWith("演示A.mp4")) return Promise.resolve(dataUrlToBuffer(DEMO_VIDEO_A));
        if (entry.endsWith("演示B.mp4")) return Promise.resolve(dataUrlToBuffer(DEMO_VIDEO_B));
        const text = demoContent(`${args.path}::${entry}`).content as string;
        return Promise.resolve(new TextEncoder().encode(text).buffer as ArrayBuffer);
      }
      case "make_dir": {
        const parent = fsGet(String(args.parent));
        const name = String(args.name).trim();
        if (!parent || !parent.dir || !name) return Promise.reject("创建失败");
        if (parent.children.has(name)) return Promise.reject("已存在同名");
        parent.children.set(name, mockDir({}));
        return Promise.resolve(fsJoin(String(args.parent), name));
      }
      case "list_plugins":
        return Promise.resolve([JSON.parse(JSON.stringify(DEMO_PLUGIN_PKG))]);
      case "read_plugin_file":
        return Promise.resolve(new TextEncoder().encode(DEMO_PLUGIN_JS).buffer);
      case "install_plugin":
        console.log("[mock] install_plugin（演示环境无插件目录）", args.zip_path);
        return Promise.resolve(JSON.parse(JSON.stringify(DEMO_PLUGIN_PKG)));
      case "uninstall_plugin":
        console.log("[mock] uninstall_plugin（演示环境无插件目录）", args.id);
        return Promise.resolve(null);
      case "smb_put_servers":
        console.log("[mock] smb_put_servers", args.servers);
        smbServers = (args.servers as Array<{ id: string; share: string }>).map((s) => ({ id: s.id, share: s.share }));
        return Promise.resolve(null);
      case "smb_test_connection":
        return Promise.resolve("192.168.1.100:445（演示服务器）");
      case "smb_cache_file": {
        const p = String(args.path);
        const node = smbGet(p);
        if (!node || node.dir) return Promise.reject("缓存失败: " + p);
        smbCached.add(p);
        console.log("[mock] 已缓存远程文件", p);
        return Promise.resolve("C:\\demo\\smb-cache\\" + p.split("/").pop());
      }
      case "smb_cached_status": {
        const p = String(args.path);
        const cached = smbCached.has(p);
        const node = smbGet(p);
        const bytes = cached && node && !node.dir ? node.content.length : 0;
        return Promise.resolve({ cached, fresh: cached, bytes });
      }
      case "smb_clear_cache": {
        let freed = 0;
        for (const p of smbCached) {
          const node = smbGet(p);
          if (node && !node.dir) freed += node.content.length;
        }
        smbCached.clear();
        return Promise.resolve(freed);
      }
      case "plugin:dialog|open": {
        // dialog 插件的参数嵌套在 options 里
        if ((args.options as { directory?: boolean } | undefined)?.directory) {
          console.log(`[mock] 目录选择: ${MOCK_FOLDER}`);
          return Promise.resolve(MOCK_FOLDER);
        }
        const paths = [...Object.keys(DEMO_BOOKS), ZIP_PATH];
        const p = paths[dialogCounter % paths.length];
        dialogCounter++;
        console.log(`[mock] 对话框选择: ${p}`);
        return Promise.resolve(p);
      }
      case "plugin:dialog|save":
        return Promise.resolve("C:\\demo\\另存输出.txt");
      case "plugin:event|listen":
        return Promise.resolve(1);
      case "plugin:event|unlisten":
        return Promise.resolve(null);
      default:
        console.warn("[mock] 未实现的命令:", cmd, args);
        return Promise.resolve(null);
    }
  },
};

console.log("[mock] 浏览器演示后端已启用（3 本演示书，依次弹出）");
export {};
