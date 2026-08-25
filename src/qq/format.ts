/**
 * QQ 消息格式化：Markdown -> QQ 纯文本（QQ 不渲染 Markdown）
 */

export function mdToPlain(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 表格分隔行
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim())
        .filter(Boolean);
      // 兜底格式：表头行【】，数据行用 · 连接（模型已按 QQ 规则输出，
      // 这里只处理漏网的 Markdown 表格）
      if (!inTable && cells.length > 1) {
        out.push("");
        out.push(`【${cells.join(" · ")}】`);
      } else {
        out.push(cells.join(" · "));
      }
      inTable = true;
      continue;
    }
    inTable = false;
    const converted = line
      .replace(/^#{1,4}\s*(.+)$/, "【$1】")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^[-*]\s+/, "• ")
      .replace(/^>\s?/, "");
    // 【小标题】前补空行，段落感
    if (/^【.+】$/.test(converted.trim()) && out.length && out[out.length - 1].trim()) {
      out.push("");
    }
    out.push(converted);
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
