/**
 * 文档生成 · 落盘与编排
 *
 * 生成的成品一律写进 data/generated/（受 RAPTOR_DATA_DIR 隔离，测试可指到临时目录）。
 * 这些文件是 agent「自己产出」的副本，删除/覆盖只允许发生在这个目录内——
 * 与附件缓存同款护栏，绝不写改用户本机原文件。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "../config";
import { renderDocument, suggestBaseName } from "./render";
import { type DocFormat, type DocumentSpec, FORMAT_EXT } from "./types";

function dataDir(): string {
  return process.env.RAPTOR_DATA_DIR ?? path.join(PROJECT_ROOT, "data");
}

export function generatedDir(): string {
  return path.join(dataDir(), "generated");
}

export interface GeneratedFile {
  format: DocFormat;
  filename: string;
  /** 绝对路径，交付给学生/上层用 */
  filePath: string;
  bytes: number;
}

/**
 * 本轮生成登记表（进程内）。
 * 动机：生成工具深在 agent 内部执行，QQ 桥拿不到工具返回值里的路径；而
 * 并发守卫只保证「同一用户串行」，不同用户可并行，纯时间窗会串台。
 * 解法：用 AsyncLocalStorage 给每轮对话打 roundId，生成时就盖章进流水，
 * 桥在结束时按自己的 roundId 精确捞回本轮成品再回传，互不污染。
 * 网页侧不在任何 round 内跑（roundId=null），只入流水不捞，靠上限淘汰。
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface RoundCtx {
  roundId: string;
}
const documentRoundStore = new AsyncLocalStorage<RoundCtx>();

/** 在指定 round 上下文中执行一轮生成，供 QQ 桥包裹 agent.generate */
export function runInDocumentRound<T>(roundId: string, fn: () => Promise<T>): Promise<T> {
  return documentRoundStore.run({ roundId }, fn);
}

interface GeneratedStamp extends GeneratedFile {
  roundId: string | null;
}
const RECENT_CAP = 200;
const recentGenerated: GeneratedStamp[] = [];

function recordGenerated(f: GeneratedFile): void {
  recentGenerated.push({ ...f, roundId: documentRoundStore.getStore()?.roundId ?? null });
  if (recentGenerated.length > RECENT_CAP)
    recentGenerated.splice(0, recentGenerated.length - RECENT_CAP);
}

/**
 * 取出（并从流水移除）属于该 roundId 且确实位于 generatedDir 内的成品。
 * 路径校验是护栏：只认本目录产出的文件，绝不把外部路径喂给 sendFile。
 */
export function drainGeneratedRound(roundId: string): GeneratedFile[] {
  const root = path.resolve(generatedDir());
  const keep: GeneratedStamp[] = [];
  const out: GeneratedFile[] = [];
  for (const item of recentGenerated) {
    const inDir = path.resolve(item.filePath).startsWith(root + path.sep);
    if (item.roundId === roundId && inDir) out.push(item);
    else keep.push(item);
  }
  recentGenerated.length = 0;
  recentGenerated.push(...keep);
  return out;
}

function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "document").slice(0, 60);
}

/** 同名自动追加 (2)(3)…，避免覆盖历史成品 */
function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}(${i++})${ext}`);
  }
  return candidate;
}

/**
 * 渲染 + 落盘一份文档，返回文件信息（含绝对路径）。
 * opts.filename 可覆盖默认建议名（不含扩展名亦可，会自动补）。
 */
export async function generateAndSave(
  spec: DocumentSpec,
  opts?: { filename?: string },
): Promise<GeneratedFile> {
  const { buffer } = await renderDocument(spec);
  const dir = generatedDir();
  await fsp.mkdir(dir, { recursive: true });
  const ext = FORMAT_EXT[spec.format];
  const baseRaw = opts?.filename?.trim() ? stripExt(opts.filename!) : suggestBaseName(spec);
  const base = sanitize(baseRaw);
  const filePath = uniquePath(dir, base, ext);
  await fsp.writeFile(filePath, buffer);
  const file: GeneratedFile = {
    format: spec.format,
    filename: path.basename(filePath),
    filePath,
    bytes: buffer.length,
  };
  recordGenerated(file);
  return file;
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

export type { DocFormat, DocumentSpec } from "./types";
export { DOC_FORMATS, isDocFormat } from "./types";
export { suggestBaseName };
