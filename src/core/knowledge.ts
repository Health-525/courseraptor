/**
 * 知识库 — 对话中沉淀的知识条目（含可选科目原件）
 *
 * 用户在对话里说出的知识点（概念/公式/方法/结论/经验）由 agent 判断后
 * 落进 data/knowledge.json，课表页 /today 的「知识」卡片与 /knowledge
 * 页共用同一份存储。用户明确要求「记下这份文件」时，把本轮上传副本
 * 抄进 data/knowledge-files/，挂在同一条知识上；没说要记录的附件不入库。
 *
 * 分类优先认课表里真实存在的课程（schedule-cache）：条目对得上某门课
 * 就归入该课程（存去掉「(上)」这类补充后的规范名）；模型给了 subject
 * 但对不上任何课程时，subject 本身就是自定义分类（如「考研数学」）。
 * 课程清单以课表缓存为准，每次写入时重算。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import { dataDir, isInsideDir } from "./paths";
import { loadScheduleCache } from "./schedule-cache";
import { findUploadByStoredPath } from "./workspace-data";

function knowledgePath(): string {
  return path.join(dataDir(), "knowledge.json");
}

function knowledgeFilesDir(): string {
  return path.join(dataDir(), "knowledge-files");
}

/** 把用户上传的副本抄进知识库目录。路径对不上上传索引就拒绝，原件仍留在上传区。 */
export function keepUploadAsKnowledgeFile(storedPath: string): KnowledgeFile {
  const upload = findUploadByStoredPath(storedPath);
  if (!upload) throw new Error("只能保存用户这次发来的文件");
  const ext = path.extname(upload.name).toLowerCase();
  const storedName = `${crypto.randomBytes(9).toString("hex")}${ext}`;
  const root = knowledgeFilesDir();
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, storedName);
  fs.copyFileSync(upload.storedPath, dest);
  return { name: upload.name, size: upload.size, storedName };
}

function unlinkKnowledgeFile(file: KnowledgeFile | undefined): void {
  if (!file?.storedName) return;
  const root = path.resolve(knowledgeFilesDir());
  const target = path.resolve(root, path.basename(file.storedName));
  if (!isInsideDir(root, target)) return;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* 原件已不在：条目照样删 */
  }
}

/** 按条目 id 读出已保存的原件；没有文件或文件丢了返回 null */
export function readKnowledgeFile(id: string): { name: string; bytes: Buffer } | null {
  const entry = readState().entries.find((e) => e.id === id);
  const file = entry?.file;
  if (!file?.storedName) return null;
  const root = path.resolve(knowledgeFilesDir());
  const target = path.resolve(root, path.basename(file.storedName));
  if (!isInsideDir(root, target)) return null;
  try {
    const bytes = fs.readFileSync(target);
    return { name: file.name, bytes };
  } catch {
    return null;
  }
}

/** 挂在知识条目上的原件。只存 knowledge-files 里的文件名，不存绝对路径。 */
export interface KnowledgeFile {
  name: string;
  size: number;
  storedName: string;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  /** 归属分类：课表课程的规范名，或 subject 指定的自定义主题；无归属为 null（未分类） */
  category: string | null;
  source?: string;
  /** 用户明确要求记下的上传原件；没有文件的笔记不带这个字段 */
  file?: KnowledgeFile;
  createdAt: number;
  updatedAt: number;
}

/** 给网页和工具看的条目：去掉磁盘文件名，只留展示用的文件名与大小 */
export function presentKnowledge(entry: KnowledgeEntry): Omit<KnowledgeEntry, "file"> & {
  file?: { name: string; size: number };
} {
  const { file, ...rest } = entry;
  return file ? { ...rest, file: { name: file.name, size: file.size } } : rest;
}

interface KnowledgeState {
  entries: KnowledgeEntry[];
}

function readState(): KnowledgeState {
  try {
    const value = JSON.parse(fs.readFileSync(knowledgePath(), "utf8")) as Partial<KnowledgeState>;
    return { entries: Array.isArray(value.entries) ? value.entries : [] };
  } catch {
    // 坏文件先隔离留档再当空（与 memory/json-cache 同一约定）：直接当空的
    // 话，下一次写入以空为基回写，全部知识无声消失
    quarantineCorruptFileSync(knowledgePath());
    return { entries: [] };
  }
}

function writeState(state: KnowledgeState): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  writeFileAtomicSync(knowledgePath(), JSON.stringify(state, null, 2));
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 同名判定键：忽略大小写与空白 */
function titleKey(title: string): string {
  return title.replace(/\s+/g, "").toLowerCase();
}

/* ── 课程归类 ─────────────────────────────────────────────── */

/** 课程名的展示规范形：去掉括号补充（「(上)」「（单）」）与多余空白 */
function canonicalName(title: string): string {
  const stripped = title
    .replace(/[（(【〔][^（）()【】〔〕]*[）)】〕]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || title.trim();
}

/** 比对用的核心名：规范形再去掉全部空白并小写 */
const coreOf = (title: string): string => canonicalName(title).replace(/\s+/g, "").toLowerCase();

/** 常见课程俗称 → 正式名。只用于模型给的 subject 提示，不替换自由文本：
 *  「提高数学水平」里就含「高数」二字，替换正文会造成误归类 */
const COURSE_ALIASES: Array<[RegExp, string]> = [
  [/高数/g, "高等数学"],
  [/大物/g, "大学物理"],
  [/大英/g, "大学英语"],
  [/线代/g, "线性代数"],
  [/概统/g, "概率论与数理统计"],
];

/** 课表里的去重课程清单（规范名）。同一门课的 (上)/(下) 合并成一个分类 */
export function courseTitles(): string[] {
  const cached = loadScheduleCache();
  if (!cached) return [];
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const course of cached.schedule.courses) {
    const title = typeof course.title === "string" ? course.title.trim() : "";
    if (!title) continue;
    const core = coreOf(title);
    if (!core || seen.has(core)) continue;
    seen.add(core);
    titles.push(canonicalName(title));
  }
  return titles;
}

/** 自定义分类名：subject 原文收敛空白并限长，超长截断保展示 */
function customCategory(subject: string): string {
  return subject.replace(/\s+/g, " ").trim().slice(0, 30);
}

/**
 * 把一条知识归类：subject 是模型给的归属提示（可选）。
 * 优先认课表里真实存在的课程——subject 与某课程核心名相等或互相包含
 * 即命中（存规范名）；subject 对不上任何课程时以其为自定义分类（用户
 * 明确给了归属，不再落「未分类」）。没给 subject 才按课程名出现在
 * 标题/正文里匹配（长名优先），都对不上返回 null（未分类）。
 */
export function matchKnowledgeCategory(text: string, subject?: string): string | null {
  const courses = courseTitles().map((title) => ({ title, core: coreOf(title) }));
  // 长名优先：「大学英语」不该被更短的「英语」抢走
  courses.sort((a, b) => b.core.length - a.core.length);

  const hintRaw = (subject ?? "").trim();
  if (hintRaw) {
    let hint = coreOf(hintRaw);
    for (const [pattern, expansion] of COURSE_ALIASES) hint = hint.replace(pattern, expansion);
    if (hint.length >= 2) {
      const exact = courses.find((c) => c.core === hint);
      if (exact) return exact.title;
      const loose = courses.find((c) => c.core.includes(hint) || hint.includes(c.core));
      if (loose) return loose.title;
      // 对不上课表课程：subject 本身就是自定义分类（如「TypeScript」「编程技术」）
      return customCategory(hintRaw);
    }
  }
  const haystack = coreOf(text);
  const hit = courses.find((c) => haystack.includes(c.core));
  return hit ? hit.title : null;
}

/* ── 条目读写 ─────────────────────────────────────────────── */

/** 全部条目，最近更新的在前 */
export function listKnowledge(): KnowledgeEntry[] {
  return readState()
    .entries.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface KnowledgeAddResult {
  entry: KnowledgeEntry;
  /** 同名条目已存在：本次是覆盖更新而非新增 */
  updatedExisting: boolean;
}

export function addKnowledge(input: {
  title: string;
  content: string;
  subject?: string;
  source?: string;
  /** 用户上传副本的本机路径；对不上上传索引时整次写入失败，不落半条笔记 */
  filePath?: string;
}): KnowledgeAddResult {
  const title = cleanText(input.title, 80);
  const content = cleanText(input.content, 2000);
  if (!title) throw new Error("请填写知识标题");
  if (!content) throw new Error("请填写知识内容");
  const file = input.filePath?.trim() ? keepUploadAsKnowledgeFile(input.filePath) : undefined;
  const category = matchKnowledgeCategory(`${title}\n${content}`, input.subject);
  const state = readState();
  // 同名知识不重复堆积：内容有变化就覆盖旧文，知识点以最新表述为准
  const existing = state.entries.find((e) => titleKey(e.title) === titleKey(title));
  const now = Date.now();
  const source = cleanText(input.source, 160);
  if (existing) {
    existing.title = title;
    existing.content = content;
    existing.category = category;
    existing.updatedAt = now;
    if (source) existing.source = source;
    if (file) {
      unlinkKnowledgeFile(existing.file);
      existing.file = file;
    }
    writeState(state);
    return { entry: existing, updatedExisting: true };
  }
  const entry: KnowledgeEntry = {
    id: crypto.randomBytes(8).toString("hex"),
    title,
    content,
    category,
    ...(source ? { source } : {}),
    ...(file ? { file } : {}),
    createdAt: now,
    updatedAt: now,
  };
  state.entries.push(entry);
  writeState(state);
  return { entry, updatedExisting: false };
}

export function updateKnowledge(
  id: string,
  patch: { title?: string; content?: string; subject?: string },
): KnowledgeEntry | null {
  const state = readState();
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return null;
  if (patch.title !== undefined) {
    const title = cleanText(patch.title, 80);
    if (!title) throw new Error("标题不能为空");
    entry.title = title;
  }
  if (patch.content !== undefined) {
    const content = cleanText(patch.content, 2000);
    if (!content) throw new Error("内容不能为空");
    entry.content = content;
  }
  if (patch.subject !== undefined) {
    // 传了 subject 就重算归属：对得上课表课程就归入该课程，对不上以 subject 为自定义分类
    entry.category = matchKnowledgeCategory(`${entry.title}\n${entry.content}`, patch.subject);
  }
  entry.updatedAt = Date.now();
  writeState(state);
  return entry;
}

export function deleteKnowledge(id: string): boolean {
  const state = readState();
  const found = state.entries.find((e) => e.id === id);
  if (!found) return false;
  unlinkKnowledgeFile(found.file);
  state.entries = state.entries.filter((e) => e.id !== id);
  writeState(state);
  return true;
}

export function clearKnowledge(): number {
  const state = readState();
  const count = state.entries.length;
  for (const entry of state.entries) unlinkKnowledgeFile(entry.file);
  state.entries = [];
  writeState(state);
  return count;
}

export function knowledgeStats(): { total: number; categorized: number; courses: number } {
  const entries = readState().entries;
  const categories = new Set(
    entries.map((e) => e.category).filter((c): c is string => typeof c === "string"),
  );
  return {
    total: entries.length,
    categorized: entries.filter((e) => e.category).length,
    courses: categories.size,
  };
}
