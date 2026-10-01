/** 安装包只包含应用代码与明确选定的公开资料；个人运行数据不参与分发。 */
const ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "biome.json",
  "start.bat",
  "README.md",
  "README.en.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ".env.example",
  ".gitignore",
  "eng.traineddata",
]);
const CODE_DIRS = new Set(["src", "local", "bin", "scripts", "tests", "gateway", "update"]);
const DOC_FILES = new Set([
  "courseraptor-logo.png",
  "courseraptor-mascot.png",
  "screenshot-demo.jpg",
  "student-guide.md",
  "configuration.md",
  "capabilities.md",
  "roadmap.md",
  "promotion.md",
  "maintainers.md",
  "hero-banner.png",
  "social-preview.jpg",
  "brand-prompt.md",
  "github-best-practices.md",
  "launch-post.md",
]);

export function shouldPackagePath(relativePath) {
  const rel = relativePath.replaceAll("\\", "/");
  if (!rel) return true;
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  if (parts.length === 1) return ROOT_FILES.has(rel) || CODE_DIRS.has(rel) || rel === "docs";
  if (parts[0] === "docs") return parts.length === 2 && DOC_FILES.has(parts[1]);
  // 管理台前端（admin/）：只带构建产物 dist（保持学生包里的网关可自托管网页管理台），
  // 源码 / node_modules / 构建配置不进学生包。
  if (parts[0] === "admin") {
    return (
      parts[1] === "dist" &&
      !parts
        .slice(2)
        .some((part) => part.startsWith(".") || /\.(?:log|enc|pem|key|bak|map)$/.test(part))
    );
  }
  if (!CODE_DIRS.has(parts[0])) return false;
  // 落地页（landing/）与技能包（skills/）不属于学生端安装包，白名单里自然排除。
  // 即使误放在代码目录，也不带出日志、密钥、编辑器备份或环境文件。
  return !parts.some((part) => part.startsWith(".") || /\.(?:log|enc|pem|key|bak)$/.test(part));
}
