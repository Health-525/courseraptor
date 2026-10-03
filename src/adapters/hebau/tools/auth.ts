/**
 * 二次认证工具：submit_auth_code
 *
 * 河北农大 CAS 在账密之后可能要求动态验证码（短信/微信/企业微信/邮箱/钉钉）。
 * 登录层此时抛 SecondFactorRequiredError 并落盘待验证会话；用户把验证码发进对话后，
 * 模型调用本工具续完登录。没有 challenge_id 时按「学校+学号」定位待验证会话——
 * 用户通常只发验证码原文，记不住 id。
 */

import { tool } from "ai";
import { z } from "zod";
import { config } from "../../../core/config";
import { completeSecondFactor } from "../cas";
import { findSecondFactor } from "../mfa";

export const authTools = {
  submit_auth_code: tool({
    description:
      "提交河北农大统一认证的动态验证码，完成二次认证登录。get_schedule / get_exams / get_grades 报「需要二次认证」时使用：向用户索要验证码原文后调用；challenge_id 用认证错误信息里给的那个，用户没提供 id 时可以不传（会按当前学号自动定位最近一次待验证会话）。成功后重新执行刚才失败的查询。",
    inputSchema: z.object({
      code: z.string().describe("用户收到的动态验证码原文"),
      challenge_id: z
        .string()
        .optional()
        .describe("二次认证会话 id（认证错误信息里给出）；不传则自动定位当前账号的待验证会话"),
    }),
    execute: async ({ code, challenge_id }) => {
      const username = (config.jwglUsername || "").trim();
      if (!username) {
        return { error: "尚未配置教务账号，无法定位二次认证会话；请先在设置面板填写学号密码" };
      }
      let challengeId = challenge_id?.trim() || "";
      if (!challengeId) {
        const pending = findSecondFactor("hebau", username);
        if (!pending) {
          return {
            error:
              "当前没有待验证的二次认证会话（可能已过期超过 10 分钟）：请重新发起一次课表/成绩/考试查询，等新的验证码发出后再提交",
          };
        }
        challengeId = pending.challengeId;
      }
      try {
        await completeSecondFactor(challengeId, code.trim(), username);
        return {
          ok: true,
          message: "二次认证完成，教务登录已生效。请立刻重新执行刚才失败的查询。",
        };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  }),
};
