/**
 * QQ 消息格式化：Markdown -> QQ 纯文本（QQ 不渲染 Markdown）
 */

export function mdToPlain(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let tableHeaderEmitted = false; // 表格首行（表头）是否已输出
  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 表格分隔行
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      out.push(
        tableHeaderEmitted
          ? "  " + cells.join("｜")
          : "【" + cells.join("｜") + "】"
      );
      tableHeaderEmitted = true;
      continue;
    }
    tableHeaderEmitted = false;
    out.push(
      line
        .replace(/^#{1,4}\s*(.+)$/, "【$1】")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^[-*]\s+/, "• ")
        .replace(/^>\s?/, "")
    );
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 按行边界分段；单行自身超长时硬切（QQ 长消息保险） */
export function splitMessage(text: string, max = 1500): string[] {
  if (text.length <= max) return [text];
  const segments: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > max) {
      if (current) {
        segments.push(current.trim());
        current = "";
      }
      segments.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (!rest) continue;
    if ((current + "\n" + rest).length > max && current) {
      segments.push(current.trim());
      current = rest;
    } else {
      current = current ? current + "\n" + rest : rest;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}
