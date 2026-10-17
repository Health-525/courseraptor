export const PORTABLE_TOP_DIR: string;
export const MAX_REL: number;
export interface ZipLintResult {
  ok: boolean;
  errors: string[];
  count: number;
  maxRel: number;
}
export function lintEntryNames(names: string[]): ZipLintResult;
export function lintPortableZip(zipPath: string): Promise<ZipLintResult>;
