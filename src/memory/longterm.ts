/**
 * 长期记忆：跨会话持久的事实条目（memory.json）
 *
 * 由 agent 通过 save_memory 工具自主增删改；
 * 启动时全量注入系统提示词（个人 agent 记忆量级小，
 * 全量注入即最可靠的「检索」；膨胀后可升级 sqlite-vec 向量检索）。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../config";
import { quarantineCorruptFile, writeFileAtomic } from "../atomic-write";

export interface MemoryEntry {
  id: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  /** active=生效中（默认）；archived=已归档，不再注入提示词 */
  status?: "active" | "archived";
  /** ISO 日期；到点后不再注入，适合一次性安排 / 任务类记忆 */
  expiresAt?: string;
}

/** 归一化：去掉空白与标点，便于比较语义是否重复 */
function normalize(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 相似度 = 归一化最长公共子序列 / 较短方长度。
 *
 * 为什么不用更常见的 bigram Jaccard：Jaccard 对长度差异惩罚过重。以 memory.json
 * 里的真实数据实测——两条真重复条目（同一条偏好换个措辞说了两遍）Jaccard 仅
 * 0.41，而两条必须区分的条目（网课备选 vs 抢课计划）也有 0.23，分离度很差；
 * 换 LCS 归一化后真重复 0.81、需区分的 0.54，中间是明显空档。
 *
 * 误合并会丢信息，漏合并只是上下文略胖，两者代价不对称，故取保守阈值。
 */
function similarity(a: string, b: string): number {
  const A = normalize(a);
  const B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;

  // 滚动数组求 LCS 长度；记忆条目量级下开销可忽略
  let prev = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array<number>(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      cur[j] =
        A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[B.length] / Math.min(A.length, B.length);
}

/** 超过该阈值视为同一条记忆的重复表述（实测：真重复 0.81，需区分的 0.54） */
const DEDUPE_THRESHOLD = 0.7;

export function isExpired(e: MemoryEntry): boolean {
  return !!e.expiresAt && Date.parse(e.expiresAt) < Date.now();
}

/** 是否还需要注入提示词：归档的、过期的都剔除 */
function isActive(e: MemoryEntry): boolean {
  return e.status !== "archived" && !isExpired(e);
}

const MEMORY_FILE = path.join(PROJECT_ROOT, "memory.json");
const MAX_ENTRIES = 100;
const MAX_PROMPT_CHARS = 4000;

export async function loadMemory(): Promise<MemoryEntry[]> {
  try {
    const data = JSON.parse(await fs.readFile(MEMORY_FILE, "utf8"));
    return Array.isArray(data?.entries) ? (data.entries as MemoryEntry[]) : [];
  } catch {
    // 文件在却读不出来 = 写坏了。直接返回 [] 的话，下一次 save_memory 会以空
    // 数组为基回写，全部记忆无声消失——先把坏文件留个副本，至少还有得救。
    await quarantineCorruptFile(MEMORY_FILE);
    return [];
  }
}

/**
 * 落盘。注意是 read-modify-write：调用方先把条目读出来改、再整个写回，
 * 所以必须原子替换——否则崩溃留下的半截 JSON 会被 loadMemory 当成「空」。
 */
async function persist(entries: MemoryEntry[]): Promise<void> {
  await writeFileAtomic(
    MEMORY_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2)
  );
}

function newId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function addMemory(
  content: string,
  category = "事实",
  expiresAt?: string
): Promise<{ entry: MemoryEntry; total: number; merged: boolean }> {
  const entries = await loadMemory();
  const now = new Date().toISOString();

  // 完全相同的直接刷新时间
  const exact = entries.find(
    (e) => e.content === content && e.category === category && isActive(e)
  );
  if (exact) {
    exact.updatedAt = now;
    await persist(entries);
    return { entry: exact, total: entries.length, merged: true };
  }

  // 近似重复：同一件事换个说法再说一遍（memory.json 里曾因此堆了两条几乎
  // 一样的「不要提及抢课」）。以较新的表述为准覆盖，避免条目无限膨胀。
  const near = entries.find(
    (e) =>
      e.category === category &&
      isActive(e) &&
      similarity(e.content, content) >= DEDUPE_THRESHOLD
  );
  if (near) {
    near.content = content;
    near.updatedAt = now;
    if (expiresAt) near.expiresAt = expiresAt;
    await persist(entries);
    return { entry: near, total: entries.length, merged: true };
  }

  const entry: MemoryEntry = {
    id: newId(),
    content,
    category,
    createdAt: now,
    updatedAt: now,
  };
  if (expiresAt) entry.expiresAt = expiresAt;
  entries.unshift(entry);
  const capped = entries.slice(0, MAX_ENTRIES);
  await persist(capped);
  return { entry, total: capped.length, merged: false };
}

export async function updateMemory(
  id: string,
  content: string
): Promise<MemoryEntry | null> {
  const entries = await loadMemory();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.content = content;
  entry.updatedAt = new Date().toISOString();
  await persist(entries);
  return entry;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const entries = await loadMemory();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  await persist(next);
  return true;
}

/**
 * 归档：条目留在文件里可追溯，但不再注入提示词。
 * 用于「事情办完了但还想留档」的场景（如已执行完的抢课计划）。
 */
export async function archiveMemory(id: string): Promise<MemoryEntry | null> {
  const entries = await loadMemory();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.status = "archived";
  entry.updatedAt = new Date().toISOString();
  await persist(entries);
  return entry;
}

/**
 * 提取用户年级（四位年，如 "2024"），供通知相关性判断使用。
 * 用户档案已存在记忆里，数据是现成的——过去通知靠模型逐条自己判断跟用户
 * 有没有关系，现在把这一步固化下来，模型的临场发挥变成产品能力。
 */
export async function loadUserGrade(): Promise<string | null> {
  const entries = await loadMemory();
  const pool = entries
    .filter((e) => /档案|用户/.test(e.category))
    .map((e) => e.content)
    .join(" ");
  if (!pool) return null;

  const direct = pool.match(/(\d{4})\s*级/);
  if (direct) return direct[1];

  // 班号如「大数据2401班」-> 前两位即入学年
  const bj = pool.match(/(\d{2})\d{2}\s*班/);
  if (bj) return `20${bj[1]}`;

  return null;
}

/** 格式化为注入系统提示词的区块（超出字符预算时从旧到新截断） */
export async function formatMemoryForPrompt(): Promise<string> {
  const all = await loadMemory();
  // 只注入生效中的条目：已归档与过期的不再占用上下文
  const entries = all.filter(isActive);
  if (entries.length === 0) return "";

  const byCategory = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  const lines: string[] = [];
  for (const [category, list] of byCategory) {
    lines.push(`### ${category}`);
    for (const e of list) lines.push(`- [${e.id}] ${e.content}`);
  }
  let text = lines.join("\n");
  if (text.length > MAX_PROMPT_CHARS) {
    text = text.slice(0, MAX_PROMPT_CHARS) + "\n…（已截断，完整条目用 save_memory list 查看）";
  }
  return `## 长期记忆（跨会话持久，条目格式 [id] 内容）\n\n${text}`;
}
