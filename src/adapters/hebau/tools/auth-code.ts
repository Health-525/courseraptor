/**
 * 二次认证工具：submit_auth_code
 *
 * 河北农大 CAS 在账密通过后常要求动态验证码。教务工具遇到时会返回
 * needs_auth_code + challenge_id 的结构化错误，模型向用户索要验证码后
 * 经本工具续完登录（会话写入缓存，同一轮里后续查询不必再登录）。
 */

import { tool } from "ai";
import { z } from "zod";
import { submitSecondFactor } from "../session";

export const authCodeTools = {
  /** 提交统一认证动态验证码 */
  submit_auth_code: tool({
    description:
      "提交学校统一认证（CAS）的动态验证码，完成被中断的教务登录。调用时机：教务工具返回了 needs_auth_code: true（说明验证码已发到用户手机/邮箱/微信）且用户已把验证码原文发来。code 传用户提供的原文（通常 6 位数字）；challenge_id 用工具报错里给的那个，用户只发了验证码时可以不填。成功后重新执行刚才失败的查询即可，不要重复调用。",
    inputSchema: z.object({
      code: z.string().describe("用户提供的验证码原文"),
      challenge_id: z
        .string()
        .optional()
        .describe("工具报错里返回的 challenge_id；用户只发了验证码时可省略"),
    }),
    execute: async ({ code, challenge_id }) => {
      const cleaned = code.trim();
      if (!cleaned) return { error: "验证码不能为空：请向用户索要验证码原文（通常 6 位数字）" };
      try {
        await submitSecondFactor({ code: cleaned, challengeId: challenge_id });
        return {
          ok: true,
          message: "验证通过，登录已完成。请重新执行刚才失败的查询（如 get_schedule）。",
        };
      } catch (e) {
        return { error: (e as Error).message, ok: false };
      }
    },
  }),
};
