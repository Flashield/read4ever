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
  "封面图片.png": mockFile(COVER_PNG),
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
  },
  bookmarks: [],
  history: [],
  bookshelf: [],
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
      case "find_prev":
        return Promise.resolve(null);
      case "list_dir": {
        const node = fsGet(String(args.path));
        if (!node || !node.dir) return Promise.reject("无法读取目录: " + args.path);
        const entries = [...node.children.entries()].map(([name, child]) => ({
          name,
          path: fsJoin(String(args.path), name),
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
        const node = fsGet(String(args.path));
        if (!node || node.dir) return Promise.reject("读取失败: " + args.path);
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
