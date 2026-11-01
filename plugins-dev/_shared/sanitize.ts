/* 轻量净化：剥危险元素、事件属性与危险协议 URL（markdown 渲染结果与 epub 章节内容共用） */
const STRIP_TAGS = new Set([
  "script", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "button", "select", "textarea",
]);
const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "background"]);

export function sanitizeTree(root: Element): void {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const remove: Element[] = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n as Element;
    if (STRIP_TAGS.has(el.tagName.toLowerCase())) {
      remove.push(el); // 连子树一起移除，先收集后删避免遍历中断
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name) && /^\s*(javascript:|vbscript:|data:text\/html)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  for (const el of remove) el.remove();
}
