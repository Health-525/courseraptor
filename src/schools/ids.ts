/**
 * 学校标识登记表（叶子模块：只依赖调用方传进来的原始字符串，不 import 适配器）
 *
 * 为什么单独一个文件：config.ts 要在启动时就校验 RAPTOR_SCHOOL，而校验不能去
 * import 适配器（适配器 import 抓取模块，抓取模块又 import config —— 循环依赖）。
 * 所以「有哪些学校」这份名单放叶子模块，注册表另处断言名单与适配器一一对应。
 */

export const DEFAULT_SCHOOL_ID = "njtech";

/** 已知学校 id。新增学校必须同时在这里和 registry 里登记 */
export const KNOWN_SCHOOL_IDS = ["njtech", "hebau"] as const;

export type KnownSchoolId = (typeof KNOWN_SCHOOL_IDS)[number];

export function isKnownSchoolId(id: string): id is KnownSchoolId {
  return (KNOWN_SCHOOL_IDS as readonly string[]).includes(id);
}

/** 校验 RAPTOR_SCHOOL 取值。未知值必须硬失败，见 normalizeSchoolId 的注释 */
export function normalizeSchoolId(raw: string | undefined): string {
  const id = (raw ?? "").trim().toLowerCase();
  if (!id) return DEFAULT_SCHOOL_ID;
  if (!isKnownSchoolId(id)) {
    throw new Error(
      `RAPTOR_SCHOOL="${raw}" 不是已知学校。可选值：${KNOWN_SCHOOL_IDS.join(" | ")}。` +
        `（不回退到默认学校是故意的：拿着一所学校的密码去登录另一所学校的教务系统，` +
        `等于把凭证发给无关的服务器。）`,
    );
  }
  return id;
}
