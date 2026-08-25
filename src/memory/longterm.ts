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

export interface MemoryEntry {
  id: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

const MEMORY_FILE = path.join(PROJECT_ROOT, "memory.json");
const MAX_ENTRIES = 100;
const MAX_PROMPT_CHARS = 4000;

export async function loadMemory(): Promise<MemoryEntry[]> {
  try {
    const data = JSON.parse(await fs.readFile(MEMORY_FILE, "utf8"));
    return Array.isArray(data?.entries) ? (data.entries as MemoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function persist(entries: MemoryEntry[]): Promise<void> {
  await fs.writeFile(
    MEMORY_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2),
    "utf8"
  );
}

function newId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function addMemory(
  content: string,
  category = "事实"
): Promise<{ entry: MemoryEntry; total: number }> {
  const entries = await loadMemory();
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: newId(),
    content,
    category,
    createdAt: now,
    updatedAt: now,
  };
  // 同类目同内容去重：更新时间即可
  const dup = entries.find(
    (e) => e.content === content && e.category === category
  );
  if (dup) {
    dup.updatedAt = now;
    await persist(entries);
    return { entry: dup, total: entries.length };
  }
  entries.unshift(entry);
  const capped = entries.slice(0, MAX_ENTRIES);
  await persist(capped);
  return { entry, total: capped.length };
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

/** 格式化为注入系统提示词的区块（超出字符预算时从旧到新截断） */
export async function formatMemoryForPrompt(): Promise<string> {
  const entries = await loadMemory();
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
