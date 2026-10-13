/**
 * 读书人物关系图谱 — 数据层
 *
 * 用户边读书边口述的人物与关系，落进 data/graph.json：
 * books 书 / persons 人物（含 aliases 别名表）/ relations 关系 /
 * memories 该书的长期记忆。
 *
 * 为什么不用 SQLite：全项目数据一律 data/*.json + 原子替换（见
 * atomic-write.ts），图谱量级（几百人物、上千关系）远在 JSON 的舒适
 * 区内，换来的是坏文件可隔离、测试能用 RAPTOR_DATA_DIR 干净重定向。
 *
 * 对话历史不在这里：会话与消息由 core/chat-sessions.ts 统一管，图谱
 * 不重复造一套。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { quarantineCorruptFileSync, writeFileAtomicSync } from "./atomic-write";
import { type GraphCategory, isGraphCategory } from "./graph-categories";
import { dataDir } from "./paths";

function graphPath(): string {
  return path.join(dataDir(), "graph.json");
}

/* ── 数据形状 ─────────────────────────────────────────────── */

export interface GraphBook {
  id: string;
  title: string;
  createdAt: number;
}

export interface GraphPerson {
  id: string;
  bookId: string;
  name: string;
  /** 同一人的其他称呼，主名不在此列 */
  aliases: string[];
  /** 一句话身份备注，如「荣国府二少爷」 */
  note: string;
  /** 重要度 1-3，影响画板节点大小 */
  importance: number;
  createdAt: number;
}

export interface GraphRelation {
  id: string;
  bookId: string;
  sourceId: string;
  targetId: string;
  category: GraphCategory;
  /** 具体关系词，如「父亲」「暗恋」 */
  label: string;
  /** 暗恋/上司为有向，朋友/同学为无向 */
  directed: boolean;
  /** 用户输入里的原句证据，没有就留空——禁止编造 */
  evidence: string;
  chapter: string;
  createdAt: number;
}

/** 带名字的图谱快照：画板与提示词共用这一种形状 */
export interface GraphSnapshot {
  bookId: string;
  version: number;
  persons: GraphPerson[];
  relations: Array<GraphRelation & { sourceName: string; targetName: string }>;
}

interface GraphState {
  books: GraphBook[];
  persons: GraphPerson[];
  relations: GraphRelation[];
  memories: Array<{ id: string; bookId: string; content: string; createdAt: number }>;
}

/**
 * 全新空状态。**每次都要新建对象**：早先用模块级 EMPTY 常量 + `{...EMPTY}`
 * 浅拷贝，books/persons/relations 四个数组是同一个引用——一次「文件不存在」
 * 的读返回的就是共享数组，后续任何写入都把数据灌进了那个跨调用共享的数组，
 * 于是「读一个空目录」竟能读出别处写进去的书。共享可变状态是这个数据层最贵的坑。
 */
function emptyState(): GraphState {
  return { books: [], persons: [], relations: [], memories: [] };
}

const newId = (): string => crypto.randomBytes(8).toString("hex");

function readState(): GraphState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(graphPath(), "utf8"));
  } catch {
    // 坏文件先隔离留档再当空（同 knowledge/memory 约定）：直接当空的话
    // 下一次写入以空为基回存，整本图谱无声消失且无任何报错
    quarantineCorruptFileSync(graphPath());
    return emptyState();
  }
  const s = parsed as Partial<GraphState>;
  // 形状校验放在入口：坏条就地丢掉，后面所有 find/filter 都只在干净数据上跑。
  // 放任一条 null 或残缺对象混进 persons，下游任何一处取 .bookId 都会崩——
  // 整份隔离又太狠（一行手滑就会连累整本图谱），逐条丢弃才是合适的粒度。
  const raw = <T>(value: unknown, ok: (v: unknown) => v is T): T[] =>
    Array.isArray(value) ? value.filter(ok) : [];
  return {
    books: raw(s.books, isBook),
    persons: raw(s.persons, usablePerson),
    relations: raw(s.relations, usableRelation),
    memories: raw(s.memories, isMemory),
  };
}

function writeState(state: GraphState): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  writeFileAtomicSync(graphPath(), JSON.stringify(state, null, 2));
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 只对读到的每一条做形状校验，坏条丢弃而不是整份隔离 */
function usablePerson(raw: unknown): raw is GraphPerson {
  const p = raw as Partial<GraphPerson>;
  return Boolean(
    p && typeof p.id === "string" && typeof p.bookId === "string" && typeof p.name === "string",
  );
}

function usableRelation(raw: unknown): raw is GraphRelation {
  const r = raw as Partial<GraphRelation>;
  return Boolean(
    r &&
      typeof r.id === "string" &&
      typeof r.bookId === "string" &&
      typeof r.sourceId === "string" &&
      typeof r.targetId === "string" &&
      typeof r.label === "string" &&
      isGraphCategory(r.category),
  );
}

function isBook(raw: unknown): raw is GraphBook {
  const b = raw as Partial<GraphBook>;
  return Boolean(b && typeof b.id === "string" && typeof b.title === "string");
}

function isMemory(
  raw: unknown,
): raw is { id: string; bookId: string; content: string; createdAt: number } {
  const m = raw as { id?: unknown; bookId?: unknown; content?: unknown };
  return Boolean(
    m && typeof m.id === "string" && typeof m.bookId === "string" && typeof m.content === "string",
  );
}

function normalizePerson(p: GraphPerson): GraphPerson {
  return {
    ...p,
    aliases: Array.isArray(p.aliases) ? p.aliases.filter((a) => typeof a === "string") : [],
    note: typeof p.note === "string" ? p.note : "",
    importance: Math.min(3, Math.max(1, Number(p.importance) || 1)),
    createdAt: Number(p.createdAt) || Date.now(),
  };
}

function normalizeRelation(r: GraphRelation): GraphRelation {
  return {
    ...r,
    directed: r.directed !== false,
    evidence: typeof r.evidence === "string" ? r.evidence : "",
    chapter: typeof r.chapter === "string" ? r.chapter : "",
    createdAt: Number(r.createdAt) || Date.now(),
  };
}

/* ── 书 ───────────────────────────────────────────────────── */

export function listBooks(): Array<GraphBook & { personCount: number; relationCount: number }> {
  const state = readState();
  return state.books
    .map((book) => ({
      ...book,
      personCount: state.persons.filter((p) => p.bookId === book.id).length,
      relationCount: state.relations.filter((r) => r.bookId === book.id).length,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function createBook(title: string): GraphBook {
  const clean = cleanText(title, 60) || "未命名";
  const state = readState();
  const book: GraphBook = { id: newId(), title: clean, createdAt: Date.now() };
  state.books.push(book);
  writeState(state);
  return book;
}

export function getBook(id: string): GraphBook | null {
  return readState().books.find((b) => b.id === id) ?? null;
}

/**
 * 决定落到哪本书：显式 id 优先，其次同名书，最后才新建。
 *
 * 同名复用而不是无条件新建——用户没指定书就每次调用都新建一本，会把图谱
 * 摊成几十本同名「未命名」，画板根本没法看。
 *
 * 但「同名复用」要让位给「用户明确给了书名」：目录里躺着一本空的占位书
 * （首访问 /api/graph 时自动建的「未命名」）时，用户说的「红楼梦」不该被
 * 塞进那本空书里——那本占位书不是他指的那本。判据是占位书是否真的空。
 */
export function resolveBookId(bookId?: string, title?: string): string {
  const state = readState();
  if (bookId) {
    const hit = state.books.find((b) => b.id === bookId);
    if (hit) return hit.id;
  }
  const wanted = title?.trim();
  if (wanted) {
    const same = state.books.find((b) => b.title === wanted);
    if (same) return same.id;
    // 只有当现存那本是**空的占位书**时，才把内容并进去；非空的书绝不挪用
    const placeholder = state.books.find((b) => isEmptyBook(state, b.id));
    if (!placeholder) return createBook(wanted).id;
    renameBook(placeholder.id, wanted);
    return placeholder.id;
  }
  if (state.books.length === 1) return (state.books[0] as GraphBook).id;
  return createBook("未命名").id;
}

/** 一本书里没有任何人物与关系 */
function isEmptyBook(state: GraphState, bookId: string): boolean {
  return (
    !state.persons.some((p) => p.bookId === bookId) &&
    !state.relations.some((r) => r.bookId === bookId)
  );
}

function renameBook(bookId: string, title: string): void {
  const state = readState();
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return;
  book.title = cleanText(title, 60) || book.title;
  writeState(state);
}

/* ── 人物 ─────────────────────────────────────────────────── */

/**
 * 主名或别名精确命中即算同一人。
 *
 * 命中多人时返回 null：同一个人被两条记录各挂了一个别名（贾宝玉/甄宝玉都
 * 叫「宝玉」）是真实会发生的数据不齐。宁可不猜——返回 null 让调用方按字面
 * 名新建并让用户去合并，也不把两个人的关系图搅成一个节点。
 */
export function findPerson(bookId: string, name: string): GraphPerson | null {
  const key = name.trim();
  if (!key) return null;
  const persons = readState().persons.filter((p) => p.bookId === bookId);
  const hits = persons.filter((p) => p.name === key || normalizePerson(p).aliases.includes(key));
  return hits.length === 1 ? normalizeOrNull(hits[0]) : null;
}

function normalizeOrNull(person: GraphPerson | undefined): GraphPerson | null {
  return person ? normalizePerson(person) : null;
}

/**
 * 简称模糊解析：「宝玉」→「贾宝玉」。只认前后缀相接且长度≥2 的形式，
 * 且必须唯一命中——命中多个说明有歧义，返回 null 让调用方按字面名新建，
 * 绝不猜。
 */
export function resolveName(bookId: string, name: string): string | null {
  if (!name || name.length < 2) return null;
  const exact = findPerson(bookId, name);
  if (exact) return exact.name;
  const hits = new Set<string>();
  for (const p of readState().persons.filter((x) => x.bookId === bookId)) {
    const names = [p.name, ...normalizePerson(p).aliases];
    if (names.some((n) => n.length >= 2 && (n.endsWith(name) || name.endsWith(n))))
      hits.add(p.name);
  }
  return hits.size === 1 ? ([...hits][0] ?? null) : null;
}

/** 按名字定位人物（含别名与简称模糊），找不到返回 null */
export function locatePerson(bookId: string, name: string): GraphPerson | null {
  const direct = findPerson(bookId, name);
  if (direct) return direct;
  const resolved = resolveName(bookId, name);
  return resolved ? findPerson(bookId, resolved) : null;
}

/**
 * 新增人物：已存在则补别名与备注（同名不重复建）。
 *
 * 命中多人时**按字面新建**而不是合并到第一个——别名撞车是数据不齐，
 * 静默并进别人身上比多出一条记录危险得多。正确修法是让用户明确合并。
 */
export function upsertPerson(
  bookId: string,
  name: string,
  aliases: string[] = [],
  note = "",
): { person: GraphPerson; merged: boolean } {
  const clean = cleanText(name, 30);
  if (!clean) throw new Error("人物名不能为空");
  const state = readState();
  const matched = state.persons.filter(
    (p) => p.bookId === bookId && (p.name === clean || normalizePerson(p).aliases.includes(clean)),
  );
  const existing = matched.length === 1 ? matched[0] : undefined;
  if (existing) {
    const person = normalizePerson(existing);
    const merged = new Set(person.aliases);
    for (const alias of aliases) {
      const a = cleanText(alias, 30);
      if (a && a !== person.name) merged.add(a);
    }
    person.aliases = [...merged];
    if (note) person.note = cleanText(note, 100);
    replacePerson(state, person);
    writeState(state);
    return { person, merged: true };
  }
  const person: GraphPerson = {
    id: newId(),
    bookId,
    name: clean,
    aliases: [...new Set(aliases.map((a) => cleanText(a, 30)).filter((a) => a && a !== clean))],
    note: cleanText(note, 100),
    importance: 1,
    createdAt: Date.now(),
  };
  state.persons.push(person);
  writeState(state);
  return { person, merged: false };
}

/** 把一个称呼并入已有主名；主名不存在时以主名新建并带上别名 */
export function addAlias(bookId: string, name: string, alias: string): GraphPerson {
  const cleanAlias = cleanText(alias, 30);
  if (!cleanAlias) throw new Error("别名不能为空");
  const existing = findPerson(bookId, name);
  if (!existing) return upsertPerson(bookId, name, [cleanAlias]).person;
  const state = readState();
  const person = normalizePerson(existing);
  if (person.name === cleanAlias) return person;
  person.aliases = [...new Set([...person.aliases, cleanAlias])].filter((a) => a !== person.name);
  replacePerson(state, person);
  writeState(state);
  return person;
}

function replacePerson(state: GraphState, person: GraphPerson): void {
  const index = state.persons.findIndex((p) => p.id === person.id);
  if (index >= 0) state.persons[index] = person;
}

/** 改名 / 改备注 / 调重要度（1-3，影响节点大小） */
export function updatePerson(
  bookId: string,
  name: string,
  patch: { newName?: string; note?: string; importance?: number } = {},
): { person: GraphPerson; oldName: string } | { error: string } {
  const found = locatePerson(bookId, name);
  if (!found) return { error: `图谱里没有「${name}」这个人物` };
  const state = readState();
  const person = normalizePerson(found);
  const newName = cleanText(patch.newName, 30) || person.name;
  if (newName !== person.name) {
    const clash = findPerson(bookId, newName);
    if (clash && clash.id !== person.id)
      return { error: `主名「${newName}」已被另一个人物占用；若指同一人请用 merge 合并别名` };
    person.name = newName;
    person.aliases = person.aliases.filter((a) => a !== newName);
  }
  if (patch.note !== undefined) person.note = cleanText(patch.note, 100);
  if (patch.importance !== undefined) {
    const level = Math.round(Number(patch.importance));
    if (!Number.isFinite(level) || level < 1 || level > 3) return { error: "重要度只能是 1-3" };
    person.importance = level;
  }
  replacePerson(state, person);
  writeState(state);
  return { person, oldName: found.name };
}

/** 删人物并连带其全部关系，返回连带删除的关系数 */
export function deletePerson(bookId: string, id: string): number {
  const state = readState();
  const before = state.relations.length;
  state.relations = state.relations.filter(
    (r) => !(r.bookId === bookId && (r.sourceId === id || r.targetId === id)),
  );
  state.persons = state.persons.filter((p) => !(p.bookId === bookId && p.id === id));
  writeState(state);
  return before - state.relations.length;
}

/* ── 关系 ─────────────────────────────────────────────────── */

/** 加关系；from/to 不存在自动建人。同一对同一关系词不重复堆 */
export function addRelation(
  bookId: string,
  fromName: string,
  toName: string,
  category: GraphCategory,
  label: string,
  opts: { evidence?: string; chapter?: string; directed?: boolean } = {},
): { relation: GraphRelation; duplicate: boolean } {
  const from = upsertPerson(bookId, fromName).person;
  const to = upsertPerson(bookId, toName).person;
  const cleanLabel = cleanText(label, 20);
  if (!cleanLabel) throw new Error("关系词不能为空");
  const state = readState();
  const dup = state.relations.find(
    (r) =>
      r.bookId === bookId &&
      r.sourceId === from.id &&
      r.targetId === to.id &&
      r.label === cleanLabel,
  );
  if (dup) return { relation: normalizeRelation(dup), duplicate: true };
  const relation: GraphRelation = {
    id: newId(),
    bookId,
    sourceId: from.id,
    targetId: to.id,
    category,
    label: cleanLabel,
    directed: opts.directed !== false,
    evidence: cleanText(opts.evidence, 300),
    chapter: cleanText(opts.chapter, 60),
    createdAt: Date.now(),
  };
  state.relations.push(relation);
  writeState(state);
  return { relation, duplicate: false };
}

/** 按「from + to + 关系词」定位一条关系；反向也认（无向关系录入方向可能相反） */
export function findRelation(
  bookId: string,
  fromName: string,
  toName: string,
  label: string,
): (GraphRelation & { fromName: string; toName: string }) | null {
  const from = locatePerson(bookId, fromName);
  const to = locatePerson(bookId, toName);
  if (!from || !to) return null;
  const relations = readState().relations.filter((r) => r.bookId === bookId);
  const match =
    relations.find((r) => r.sourceId === from.id && r.targetId === to.id && r.label === label) ??
    relations.find((r) => r.sourceId === to.id && r.targetId === from.id && r.label === label);
  if (!match) return null;
  const person = normalizePerson(from);
  return { ...normalizeRelation(match), fromName: person.name, toName: to.name };
}

/** 修正一条已有关系：改词 / 改类别 / 改方向 / 补证据章节 */
export function updateRelation(
  bookId: string,
  fromName: string,
  toName: string,
  label: string,
  patch: {
    newLabel?: string;
    newCategory?: GraphCategory;
    directed?: boolean;
    evidence?: string;
    chapter?: string;
  } = {},
): { relation: GraphRelation } | { error: string } {
  const rel = findRelation(bookId, fromName, toName, label);
  if (!rel) return { error: `没找到「${fromName} —${label}→ ${toName}」这条关系` };
  const state = readState();
  const target = state.relations.find((r) => r.id === rel.id);
  if (!target) return { error: "关系已不存在，请重试" };
  if (patch.newLabel !== undefined) {
    const clean = cleanText(patch.newLabel, 20);
    if (!clean) return { error: "关系词不能为空" };
    target.label = clean;
  }
  if (patch.newCategory !== undefined) {
    if (!isGraphCategory(patch.newCategory)) return { error: `未知关系类别：${patch.newCategory}` };
    target.category = patch.newCategory;
  }
  if (patch.directed !== undefined) target.directed = patch.directed;
  if (patch.evidence !== undefined) target.evidence = cleanText(patch.evidence, 300);
  if (patch.chapter !== undefined) target.chapter = cleanText(patch.chapter, 60);
  writeState(state);
  return { relation: target };
}

/** 删单条关系（人物保留）。命中返回 id，未命中返回 null */
export function deleteRelation(bookId: string, id: string): string | null {
  const state = readState();
  const target = state.relations.find((r) => r.bookId === bookId && r.id === id);
  if (!target) return null;
  state.relations = state.relations.filter((r) => r.id !== id);
  writeState(state);
  return id;
}

/** 按名字删关系（对话里说「删掉张三和李四的仇人关系」走这条） */
export function deleteRelationByNames(
  bookId: string,
  fromName: string,
  toName: string,
  label: string,
): { deleted: string; label: string } | { error: string } {
  const rel = findRelation(bookId, fromName, toName, label);
  if (!rel) return { error: `没找到「${fromName} —${label}→ ${toName}」这条关系` };
  deleteRelation(bookId, rel.id);
  return { deleted: rel.id, label: rel.label };
}

/** 清空一本书的整个人物图谱（人物与关系全删，不可恢复） */
export function clearGraph(bookId: string): { persons: number; relations: number } {
  const state = readState();
  const persons = state.persons.filter((p) => p.bookId === bookId).length;
  const relations = state.relations.filter((r) => r.bookId === bookId).length;
  state.persons = state.persons.filter((p) => p.bookId !== bookId);
  state.relations = state.relations.filter((r) => r.bookId !== bookId);
  writeState(state);
  return { persons, relations };
}

/* ── 图谱快照 ─────────────────────────────────────────────── */

/**
 * 取一本书的图谱全貌。重要度降序、同级按加入顺序——画板布局与提示词
 * 注入都依赖这个稳定排序，不能换。
 */
export function getGraph(bookId: string): GraphSnapshot {
  const state = readState();
  // 守卫必须写在最前：数组里混入的 null / 残缺对象在取属性时就会崩，
  // 先判形状再判归属，坏条只丢自己
  const persons = state.persons
    .filter((p) => usablePerson(p) && p.bookId === bookId)
    .map(normalizePerson)
    .sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt);
  const byId = new Map(persons.map((p) => [p.id, p]));
  const relations = state.relations
    .filter((r) => usableRelation(r) && r.bookId === bookId)
    .map(normalizeRelation)
    .map((r) => ({
      ...r,
      sourceName: byId.get(r.sourceId)?.name ?? "",
      targetName: byId.get(r.targetId)?.name ?? "",
    }))
    // 端点已被删除的关系不外泄给画板，避免画出悬空连线
    .filter((r) => r.sourceName !== "" && r.targetName !== "");
  return { bookId, version: Date.now(), persons, relations };
}

/** 某人当前全部关系（对话里回答「他俩什么关系」前先查这个） */
export function relationsOfPerson(
  bookId: string,
  name: string,
): { person: GraphPerson; relations: GraphSnapshot["relations"] } | null {
  const person = locatePerson(bookId, name);
  if (!person) return null;
  const graph = getGraph(bookId);
  return {
    person,
    relations: graph.relations.filter((r) => r.sourceId === person.id || r.targetId === person.id),
  };
}

/** 注入系统提示词的图谱概览；空图谱给一句明确提示，模型才知道该介绍功能 */
export function graphSummary(bookId: string): string {
  const graph = getGraph(bookId);
  if (!graph.persons.length) return "（当前图谱为空）";
  const lines = graph.relations.map(
    (r) =>
      `${r.sourceName} --[${r.label}]--> ${r.targetName}${r.evidence ? `（证据：${r.evidence.slice(0, 40)}）` : ""}`,
  );
  const book = getBook(bookId);
  const head = book ? `《${book.title}》` : "当前";
  return `${head}共 ${graph.persons.length} 个人物、${graph.relations.length} 条关系：\n${lines.join("\n")}`;
}

/* ── 长期记忆（按书隔离） ─────────────────────────────────── */

export function addMemory(bookId: string, content: string): void {
  const clean = cleanText(content, 500);
  if (!clean) return;
  const state = readState();
  state.memories.push({ id: newId(), bookId, content: clean, createdAt: Date.now() });
  writeState(state);
}

export function listMemories(bookId: string, limit = 20): Array<{ id: string; content: string }> {
  return readState()
    .memories.filter((m) => m.bookId === bookId)
    .slice(-limit)
    .map((m) => ({ id: m.id, content: m.content }));
}

/* ── 导入导出 ─────────────────────────────────────────────── */

export interface GraphExport {
  version: 1;
  book: GraphBook | null;
  bookTitle: string;
  persons: Array<Omit<GraphPerson, "id" | "bookId">>;
  relations: Array<{
    category: GraphCategory;
    label: string;
    directed: boolean;
    evidence: string;
    chapter: string;
    sourceName: string;
    targetName: string;
  }>;
  memories: Array<{ content: string }>;
}

/** 导出一本书的全图谱（按人名而非内部 id 落盘，换库也能导入） */
export function exportGraph(bookId: string): GraphExport {
  const graph = getGraph(bookId);
  return {
    version: 1,
    book: getBook(bookId),
    bookTitle: getBook(bookId)?.title ?? "",
    persons: graph.persons.map((p) => ({
      name: p.name,
      aliases: p.aliases,
      note: p.note,
      importance: p.importance,
      createdAt: p.createdAt,
    })),
    relations: graph.relations.map((r) => ({
      category: r.category,
      label: r.label,
      directed: r.directed,
      evidence: r.evidence,
      chapter: r.chapter,
      sourceName: r.sourceName,
      targetName: r.targetName,
    })),
    memories: listMemories(bookId, 500).map((m) => ({ content: m.content })),
  };
}

/** 导入为新书（不覆盖已有数据），返回新书 id */
export function importGraph(input: Partial<GraphExport> & { bookTitle?: string }): GraphBook {
  const title = cleanText(input.bookTitle ?? input.book?.title, 60) || "未命名";
  const book = createBook(title);
  for (const raw of input.persons ?? []) {
    const name = cleanText(raw.name, 30);
    if (!name) continue;
    const person = upsertPerson(book.id, name, raw.aliases ?? [], raw.note ?? "").person;
    const level = Math.round(Number(raw.importance));
    if (Number.isFinite(level) && level >= 1 && level <= 3) {
      updatePerson(book.id, name, { importance: level });
      void person;
    }
  }
  for (const raw of input.relations ?? []) {
    if (!isGraphCategory(raw.category)) continue;
    try {
      addRelation(book.id, raw.sourceName, raw.targetName, raw.category, raw.label, {
        evidence: raw.evidence,
        chapter: raw.chapter,
        directed: raw.directed,
      });
    } catch {
      // 端点名缺失或关系词为空的单条跳过，不让一条坏数据毁掉整次导入
    }
  }
  for (const m of input.memories ?? []) addMemory(book.id, m.content);
  return book;
}
