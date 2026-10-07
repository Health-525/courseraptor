/** scripts/package-skill.mjs 的类型声明 */

export interface SkillPackageResult {
  /** 技能名（export-schedule / meta-learning） */
  skill: string;
  version: string;
  /** 可整目录拷进 ~/.workbuddy/skills/ 的技能目录 */
  skillDir: string;
  /** 分发用 zip（条目带 <技能名>/ 前缀） */
  zipPath: string;
  /** zip 内条目名清单 */
  files: string[];
  /** 单文件 bundle 字节数（纯提示词技能为 0） */
  bundleBytes: number;
  /** 纯提示词技能（无 scripts/bundle/.env，SKILL.md + references 整拷即用） */
  promptOnly: boolean;
  /** CLI 自检配置（纯提示词技能无脚本，为 undefined） */
  selfCheck?: { args: string[]; expect: RegExp[] };
}

export function zipEntries(
  entries: Array<{ name: string; data: Buffer | string; mtime?: Date }>,
): Buffer;

export function buildSkillPackage(options?: {
  projectRoot?: string;
  outDir?: string;
  /** 打包哪个技能（默认 export-schedule） */
  skill?: string;
  /** 是否随包暂装原生二进制（resvg；测试传 false 跳过网络请求） */
  includeBinaries?: boolean;
}): Promise<SkillPackageResult>;
