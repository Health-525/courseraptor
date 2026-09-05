/** 安装包只包含应用代码与明确选定的公开资料；个人运行数据不参与分发。 */
const ROOT_FILES = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "biome.json", "start.bat",
  "README.md", "README.en.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ".env.example", ".gitignore",
  "eng.traineddata",
]);
const CODE_DIRS = new Set(["src", "bin", "scripts", "tests", "server"]);
const DOC_FILES = new Set([
  "courseraptor-logo.png", "courseraptor-mascot.png", "screenshot-demo.jpg",
  "student-guide.md", "configuration.md", "capabilities.md", "roadmap.md", "promotion.md",
  "maintainers.md", "hero-banner.png", "social-preview.jpg", "brand-prompt.md", "github-best-practices.md", "launch-post.md",
]);

export function shouldPackagePath(relativePath) {
  const rel = relativePath.replaceAll("\\", "/");
  if (!rel) return true;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  if (parts.length === 1) return ROOT_FILES.has(rel) || CODE_DIRS.has(rel) || rel === "docs";
  if (parts[0] === "docs") return parts.length === 2 && DOC_FILES.has(parts[1]);
  if (!CODE_DIRS.has(parts[0])) return false;
  // 即使误放在代码目录，也不带出日志、密钥、编辑器备份或环境文件。
  return !parts.some((part) => part.startsWith(".") || /\.(?:log|enc|pem|key|bak)$/.test(part));
}
