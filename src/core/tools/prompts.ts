/**
 * 提示词模板工具：manage_prompts
 *
 * 维护网页输入框上方的「提示词」chips（功能大厅「提示词模板」面板
 * 同一份数据，存于 credentialsStore.webQuickQuestions），让用户在
 * 对话里说「加一条提示词」「把第 2 个改成…」就能代改。归一化与默认
 * 清单在 core/quick-questions.ts——网页设置接口与对话工具共用同一份
 * 规则，空列表按既定设计回退默认清单。
 */

import { tool } from "ai";
import { z } from "zod";

import { loadCredentialsStore, saveCredentialsStore } from "../credentials";
import {
  DEFAULT_QUESTIONS,
  effectiveQuickQuestions,
  normalizeQuickQuestions,
  QUICK_QUESTION_MAX_CHARS,
  QUICK_QUESTION_MAX_COUNT,
} from "../quick-questions";

/** 当前生效清单与自定义标记：没存过/存空时生效清单即默认模板 */
function currentPrompts(): { effective: string[]; customized: boolean } {
  const stored = loadCredentialsStore()?.webQuickQuestions;
  return { effective: [...effectiveQuickQuestions(stored)], customized: Boolean(stored?.length) };
}

function savePrompts(list: string[]): void {
  saveCredentialsStore({ webQuickQuestions: normalizeQuickQuestions(list) });
}

const withIds = (list: string[]) => list.map((text, i) => ({ id: String(i), text }));

/** 单条校验：非空且不超长（超长直接报错让模型转告用户，不静默截断） */
function promptError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "提示词不能为空";
  if (value.length > QUICK_QUESTION_MAX_CHARS) {
    return `「${value.slice(0, 20)}…」超过 ${QUICK_QUESTION_MAX_CHARS} 字上限，请缩短`;
  }
  return null;
}

function indexError(id: string): string {
  return `条目 id 无效：${id}。id 来自上一次 list 结果，清单有增删后请重新 list。`;
}

export const promptTools = {
  manage_prompts: tool({
    description:
      "维护网页输入框上方的「提示词」chips（功能大厅「提示词模板」面板同一份数据，改动立即生效）。" +
      "用户说「加一条提示词/快捷问题」「把第 2 个改成…」「删掉『导出课表』那条」「恢复默认提示词」时调用。" +
      "list 拿条目 id（id 是当前清单下标，增删后会变，改前重新 list），add 批量加（每条 ≤60 字，" +
      `清单总量 ≤${QUICK_QUESTION_MAX_COUNT} 条，重复的会被拒），update 按 id 改文案，delete 按 ids 批量删，` +
      "reset 恢复默认清单。全部删空时按既定设计自动回默认清单，如实告诉用户即可。",
    inputSchema: z.object({
      action: z
        .enum(["list", "add", "update", "delete", "reset"])
        .describe(
          "list=列出当前清单（拿 id），add=批量添加，update=按 id 改文案，delete=按 ids 批量删除，reset=恢复默认清单",
        ),
      items: z.array(z.string()).optional().describe("add 必填：一批提示词文案（每条 ≤60 字）"),
      id: z.string().optional().describe("目标条目 id（update 必填，来自 list 结果）"),
      text: z.string().optional().describe("update 时的新文案（≤60 字）"),
      ids: z.array(z.string()).optional().describe("delete 必填：要删除的条目 id 列表"),
    }),
    execute: async ({ action, items, id, text, ids }) => {
      const { effective, customized } = currentPrompts();

      if (action === "list") {
        return {
          summary: customized
            ? `自定义清单，共 ${effective.length} 条`
            : `当前是默认清单，共 ${effective.length} 条`,
          prompts: withIds(effective),
          ...(customized ? {} : { note: "还没自定义过；update/delete 会先把默认清单固化再改" }),
        };
      }

      if (action === "reset") {
        savePrompts([]);
        return {
          ok: true,
          summary: "已恢复默认提示词清单",
          prompts: withIds([...DEFAULT_QUESTIONS]),
        };
      }

      if (action === "add") {
        if (!items?.length) return { error: "add 需要 items（至少一条提示词）" };
        const next = [...effective];
        for (const raw of items) {
          const invalid = promptError(raw);
          if (invalid) return { error: invalid };
          const value = raw.trim();
          if (next.includes(value)) return { error: `「${value}」已经在清单里` };
          next.push(value);
        }
        if (next.length > QUICK_QUESTION_MAX_COUNT) {
          return {
            error: `清单最多 ${QUICK_QUESTION_MAX_COUNT} 条（当前 ${effective.length} 条），先删几条再加`,
          };
        }
        savePrompts(next);
        return {
          ok: true,
          summary: `已添加 ${items.length} 条提示词（共 ${next.length} 条）`,
          prompts: withIds(next),
        };
      }

      if (action === "update") {
        if (text === undefined) return { error: "update 需要 text（新文案）" };
        const invalid = promptError(text);
        if (invalid) return { error: invalid };
        const i = Number(id);
        if (!Number.isInteger(i) || i < 0 || i >= effective.length)
          return { error: indexError(String(id)) };
        const value = text.trim();
        if (effective.some((q, j) => j !== i && q === value))
          return { error: `「${value}」已经在清单里` };
        const next = [...effective];
        const old = next[i] ?? "";
        next[i] = value;
        savePrompts(next);
        return {
          ok: true,
          summary: `已改提示词：${old} → ${value}`,
          prompts: withIds(next),
        };
      }

      // delete
      if (!ids?.length) return { error: "delete 需要 ids（来自 list 结果的条目 id 列表）" };
      const targets: number[] = [];
      for (const raw of ids) {
        const i = Number(raw);
        if (!Number.isInteger(i) || i < 0 || i >= effective.length)
          return { error: indexError(raw) };
        targets.push(i);
      }
      const dropped = [...new Set(targets)];
      const removed = dropped.map((i) => effective[i] ?? `#${i}`);
      const next = effective.filter((_, j) => !dropped.includes(j));
      if (!next.length) {
        savePrompts([]);
        return {
          ok: true,
          summary: "已删完全部提示词；空清单按既定设计回退为默认模板",
          prompts: withIds([...DEFAULT_QUESTIONS]),
          note: "清单最少会保留默认模板；要换掉某条用 update 改文案更直接。",
        };
      }
      savePrompts(next);
      return {
        ok: true,
        summary: `已删除 ${dropped.length} 条提示词（剩 ${next.length} 条）：${removed.join("、")}`,
        prompts: withIds(next),
      };
    },
  }),
};
