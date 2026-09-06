/**
 * 学校与认证状态工具：get_school_status / submit_auth_code
 *
 * 为什么需要这两个：
 * - 多校以后「你现在服务哪所学校、这所学校能查什么」是模型必须知道的事实。
 *   没有这个工具，模型只能背提示词；提示词与适配器能力表一旦不同步就会说错。
 * - 河北农大统一认证会在账密之后再要一个动态码。对话式 agent 拿不到用户手机，
 *   只能走「工具报需要验证码 → 模型向用户索要 → 用户回验证码 → 本工具续完登录」。
 *   这一步没有专门工具的话，登录会永远卡在第一次调用上。
 */

import { tool } from "ai";
import { z } from "zod";

import { config } from "../config";
import { findSecondFactor } from "../schools/mfa";
import { activeSchool, allSchools } from "../schools/registry";
import { CAPABILITY_LABELS, type SchoolCapability } from "../schools/types";
import { invalidateSession, submitAuthCode } from "./session";

/** 全部能力键。由标签表反推，保证清单与门禁话术同源 */
const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as SchoolCapability[];

export const schoolTools = {
  /** 当前学校与能力清单 */
  get_school_status: tool({
    description:
      "查询当前服务的学校、教务入口、所在城市，以及这所学校已接入/未接入的能力清单（可选传 school 查其他学校的配置）。多校以后任何「你能不能查××」的问题都以本工具返回为准，不要凭印象回答——能力按学校划分，换学校就换了一批能力。",
    inputSchema: z.object({
      school: z
        .string()
        .optional()
        .describe("要查看的学校 id（如 njtech / hebau）；不填查当前生效的学校"),
    }),
    execute: async ({ school }) => {
      const active = activeSchool();
      const target = school ? allSchools().find((s) => s.id === school) : active;
      if (!target) {
        return {
          error: `没有 id 为「${school}」的学校。可选：${allSchools()
            .map((s) => `${s.id}（${s.name}）`)
            .join("、")}`,
        };
      }
      const unsupported = ALL_CAPABILITIES.filter((cap) => !target.capabilities.includes(cap));
      return {
        school: target.id,
        name: target.name,
        active: target.id === active.id,
        city: target.city,
        jwglBase: target.jwglBase,
        gpaBasis: target.gpaBasis,
        secondFactor: target.supportsSecondFactor ? "可能要求动态码二次认证" : "不需要二次认证",
        supported: target.capabilities.map((cap) => CAPABILITY_LABELS[cap]),
        unsupported: unsupported.map((cap) => CAPABILITY_LABELS[cap]),
        credentials:
          target.id === active.id
            ? config.jwglUsername && config.jwglPassword
              ? `已配置学号 ${config.jwglUsername}（来源 ${config.credentialsSource}）`
              : "未配置：按启动引导录入，或在 .env 设置 JWGL_USERNAME / JWGL_PASSWORD"
            : "（非当前生效学校，不检查凭证）",
      };
    },
  }),

  /** 提交二次认证验证码 */
  submit_auth_code: tool({
    description:
      "提交学校统一认证的动态验证码，完成被二次认证打断的登录。只在其他教务工具返回「需要二次认证」之后调用：先向用户索要手机/邮箱收到的验证码原文，拿到码再调本工具。challenge_id 可省略（系统按当前学校+当前学号找待验证会话）。码对上了登录即完成，之后重试刚才那个查询即可。",
    inputSchema: z.object({
      code: z.string().describe("用户发来的验证码数字串"),
      challenge_id: z
        .string()
        .optional()
        .describe("待验证会话 ID。省略时自动用当前学校+学号最新的那一条"),
    }),
    execute: async ({ code, challenge_id }) => {
      const school = activeSchool();
      if (!school.supportsSecondFactor) {
        return {
          error: `${school.name}的教务登录不要求二次认证。如果是别的原因登录失败，按错误信息处理，不要调本工具。`,
        };
      }
      const digits = code.replace(/\D/g, "");
      if (!digits) {
        return {
          error: "没收到验证码数字。请把手机/邮箱里收到的验证码原样发给我（例如「483920」）。",
        };
      }
      const pending = challenge_id ? null : findSecondFactor(school.id, config.jwglUsername);
      const id = challenge_id ?? pending?.challengeId;
      if (!id) {
        return {
          error:
            "当前没有等待验证码的登录会话（可能已过期或已用完）。先重新查一次课表/成绩触发登录，拿到新的验证码再提交。",
        };
      }

      // 上一轮的失败会话不能留着：否则用户以为还能用旧码重试
      invalidateSession();
      try {
        const session = await submitAuthCode(id, digits);
        return {
          ok: true,
          school: school.name,
          username: session.username,
          note: "登录已完成。请立刻重试刚才那个查询（课表/成绩/考试），不必再让用户提供账号。",
        };
      } catch (e) {
        return { error: `验证码提交失败：${(e as Error).message}` };
      }
    },
  }),
};
