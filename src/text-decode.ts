/**
 * 文本字节解码
 *
 * 教务处导出的 txt/csv 大量是 GBK/GB2312 编码（Windows 记事本时代的默认值），
 * 一律按 utf8 强解中文必乱码。这里按可靠度排序：BOM 优先 → 严格 UTF-8 校验 →
 * GBK 兜底。Node 官方构建自带全量 ICU，TextDecoder 原生认 GBK，无需 iconv 依赖。
 */

/** 有 BOM 直接按 BOM 解（TextDecoder 默认会剥掉 BOM 本身） */
function decodeByBom(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return new TextDecoder("utf-8").decode(buf);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder("utf-16be").decode(buf);
  return null;
}

/** 解码文本文件字节：UTF-8（含 BOM 变体）→ GBK → 替换字符兜底，永不抛错 */
export function decodeTextBuffer(buf: Buffer): string {
  const bommed = decodeByBom(buf);
  if (bommed !== null) return bommed;
  try {
    // fatal：任何非法字节序列都抛错——抛了才有资格谈 GBK 兜底，
    // 否则合法 UTF-8 里的「偶尔乱一个字」会被 GBK 悄悄解成别的字
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      // 自编译裁掉 ICU 的 Node 才会走到这：退回旧行为（替换字符）
      return buf.toString("utf8");
    }
  }
}
