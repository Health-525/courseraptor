/** scripts/package-skill.mjs 的类型声明（同 gateway/*.d.mts 惯例） */

export interface SkillPackageResult {
  /** 技能名（njtech-jwgl / export-schedule） */
  skill: string;
  version: string;
  /** 可整目录拷进 ~/.workbuddy/skills/ 的技能目录 */
  skillDir: string;
  /** 分发用 zip（条目带 <技能名>/ 前缀） */
  zipPath: string;
  /** zip 内条目名清单 */
  files: string[];
  bundleBytes: number;
  /** CLI 自检配置（打包完成后跑一次入口脚本验证可用） */
  selfCheck: { args: string[]; expect: RegExp[] };
}

export function zipEntries(
  entries: Array<{ name: string; data: Buffer | string; mtime?: Date }>,
): Buffer;

export function buildSkillPackage(options?: {
  projectRoot?: string;
  outDir?: string;
  /** 打包哪个技能（默认 njtech-jwgl，向后兼容） */
  skill?: string;
  /** 是否随包暂装原生二进制（resvg；测试传 false 跳过网络请求） */
  includeBinaries?: boolean;
}): Promise<SkillPackageResult>;
