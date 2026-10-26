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
  bookshelf: [],
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
