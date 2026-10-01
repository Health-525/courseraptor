/** scripts/package-skill.mjs 的类型声明（同 gateway/*.d.mts 惯例） */

export interface SkillPackageResult {
  version: string;
  /** 可整目录拷进 ~/.workbuddy/skills/ 的技能目录 */
  skillDir: string;
  /** 分发用 zip（条目带 njtech-jwgl/ 前缀） */
  zipPath: string;
  /** zip 内条目名清单 */
  files: string[];
  bundleBytes: number;
}

export function zipEntries(
  entries: Array<{ name: string; data: Buffer | string; mtime?: Date }>,
): Buffer;

export function buildSkillPackage(options?: {
  projectRoot?: string;
  outDir?: string;
}): Promise<SkillPackageResult>;
