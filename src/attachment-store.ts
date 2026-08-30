/**
 * 附件/文件缓存库
 *
 * 动机：教务处附件（尤其大 xlsx）过去每次查询都重新下载、重新 OCR 验证码，
 * 且解析结果只活在一坨被掐断的文本里。这里把「下载一次、落盘、之后反复查」
 * 做成基础设施：
 * - 所有 agent 抓取/读入的文件统一存 data/attachments/files/，索引 index.json
 * - 同一 URL 再来直接命中缓存（不再走下载与验证码链路）
 * - 删除仅限索引登记过的文件，且物理路径必须锁死在缓存目录内——
 *   agent 只能删自己下载的东西，永远删不到用户的文件
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { PROJECT_ROOT } from "./config";
import { writeFileAtomic } from "./atomic-write";

/** 数据目录（测试可用 RAPTOR_DATA_DIR 指到临时目录，与 chat-sessions 同款） */
function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

export function attachmentDir(): string {
  return path.join(dataDir(), "attachments");
}

function filesDir(): string {
  return path.join(attachmentDir(), "files");
}

function indexFile(): string {
  return path.join(attachmentDir(), "index.json");
}

export type AttachmentKind = "table" | "text" | "other";

export interface AttachmentMeta {
  /** 稳定短 id：sha(source key) 前 12 位，query_table / 删除都靠它 */
  id: string;
  filename: string;
  kind: AttachmentKind;
  format: string;
  source: "url" | "local";
  url?: string;
  /** 本机原始路径（source=local 时） */
  originPath?: string;
  /** 缓存内物理路径（删除只允许发生在这里，且必须在 filesDir 下） */
  storedPath: string;
  size: number;
  fetchedAt: string;
  /** 表格类：sheet 名列表（概览由表格引擎现算，这里只留结构线索） */
  sheetNames?: string[];
  /** 文本类：解析后全文字符数 */
  textLength?: number;
  /** 累计命中次数（诊断用） */
  hits: number;
}

type IndexShape = Record<string, AttachmentMeta>;

function loadIndexSync(): IndexShape {
  try {
    const raw = fs.readFileSync(indexFile(), "utf8");
    const parsed = JSON.parse(raw) as IndexShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveIndex(idx: IndexShape): Promise<void> {
  await writeFileAtomic(indexFile(), JSON.stringify(idx, null, 2));
}

/** 稳定 id：同一 URL / 同一路径永远映射到同一个 id */
export function attachmentIdForSource(source: "url" | "local", key: string): string {
  const norm =
    source === "url"
      ? key.trim()
      : path.resolve(key).toLowerCase().replace(/\\/g, "/");
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

/** 按 URL 查缓存（文件物理存在才算命中，被手动清掉则视为无） */
export function findByUrl(url: string): AttachmentMeta | null {
  return findBySource("url", url);
}

/** 按本地路径查缓存 */
export function findByLocalPath(p: string): AttachmentMeta | null {
  return findBySource("local", p);
}

function findBySource(source: "url" | "local", key: string): AttachmentMeta | null {
  const id = attachmentIdForSource(source, key);
  const meta = loadIndexSync()[id];
  if (!meta) return null;
  if (!fs.existsSync(meta.storedPath)) return null;
  return meta;
}

export function getMeta(id: string): AttachmentMeta | null {
  const meta = loadIndexSync()[id.trim()];
  if (!meta || !fs.existsSync(meta.storedPath)) return null;
  return meta;
}

/** 读缓存文件的原始字节（不存在返回 null） */
export function readStoredBuffer(id: string): Buffer | null {
  const meta = getMeta(id);
  if (!meta) return null;
  try {
    return fs.readFileSync(meta.storedPath);
  } catch {
    return null;
  }
}

/**
 * 落盘一个文件并登记索引。同 id 覆盖写入（本地文件更新后重读的场景）。
 */
export async function putAttachment(input: {
  id: string;
  filename: string;
  kind: AttachmentKind;
  format: string;
  source: "url" | "local";
  url?: string;
  originPath?: string;
  buf: Buffer;
  sheetNames?: string[];
  textLength?: number;
}): Promise<AttachmentMeta> {
  await fsp.mkdir(filesDir(), { recursive: true });
  const ext = (input.filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? "").replace(
    /[^a-z0-9.]/g,
    ""
  );
  const storedPath = path.join(filesDir(), input.id + ext);
  await fsp.writeFile(storedPath, input.buf);
  const meta: AttachmentMeta = {
    id: input.id,
    filename: input.filename,
    kind: input.kind,
    format: input.format,
    source: input.source,
    ...(input.url ? { url: input.url } : {}),
    ...(input.originPath ? { originPath: input.originPath } : {}),
    storedPath,
    size: input.buf.length,
    fetchedAt: new Date().toISOString(),
    ...(input.sheetNames ? { sheetNames: input.sheetNames } : {}),
    ...(input.textLength != null ? { textLength: input.textLength } : {}),
    hits: 0,
  };
  const idx = loadIndexSync();
  idx[meta.id] = meta;
  await saveIndex(idx);
  return meta;
}

/** 命中缓存时累加 hits（尽力而为，失败不影响读取） */
export function touchAttachment(id: string): void {
  try {
    const idx = loadIndexSync();
    if (idx[id]) {
      idx[id].hits++;
      void saveIndex(idx);
    }
  } catch {
    /* 统计而已 */
  }
}

export function listAttachments(): AttachmentMeta[] {
  return Object.values(loadIndexSync()).sort((a, b) =>
    b.fetchedAt.localeCompare(a.fetchedAt)
  );
}

/** 缓存目录总占用（字节）与条数 */
export function attachmentStats(): { count: number; totalBytes: number } {
  const all = listAttachments();
  return {
    count: all.length,
    totalBytes: all.reduce((s, m) => s + m.size, 0),
  };
}

/**
 * 删除一条缓存。双重护栏：
 * 1. 只认索引里登记过的 id（没登记 = 不是 agent 下载的 = 拒绝）；
 * 2. 物理路径 resolve 后必须仍在 filesDir 内（防索引被外部改坏后越界删除）。
 * 返回 false = 未找到或拒绝，不抛错。
 */
export async function deleteAttachment(id: string): Promise<boolean> {
  const idx = loadIndexSync();
  const meta = idx[id.trim()];
  if (!meta) return false;
  const filesRoot = path.resolve(filesDir());
  const target = path.resolve(meta.storedPath);
  if (target !== filesRoot && !target.startsWith(filesRoot + path.sep)) {
    // 索引指向缓存目录之外：宁可删不掉，也绝不越界
    delete idx[id];
    await saveIndex(idx);
    return false;
  }
  await fsp.rm(target, { force: true }).catch(() => {});
  delete idx[id];
  await saveIndex(idx);
  return true;
}

/** 清空全部缓存（同样只删 filesDir 内的文件） */
export async function clearAttachments(): Promise<number> {
  const all = listAttachments();
  let removed = 0;
  for (const m of all) {
    if (await deleteAttachment(m.id)) removed++;
  }
  return removed;
}
