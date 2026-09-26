// CourseRaptor 单文件 exe 启动器。
// 由 scripts/package-exe.mjs 注入版本号后，用 Windows 自带的 csc.exe 编译；
// 便携 zip 以 Win32 资源（raptor.portable.zip）嵌在同一 exe 里。
//
// 行为：
//   - 安装目录 = exe 旁边（exe 已在 CourseRaptor 文件夹内则直接复用），环境变量 RAPTOR_PORTABLE_HOME 可整体重定向；
//   - 内置版本号与目录下 .portable-version 标记不同才重新释放 zip（同学本地 data/、
//     凭证等运行数据不在 zip 里，升级覆盖不影响）；
//   - 释放后用 runtime\node.exe 启动 app\bin\raptor.cjs（与便携版 start.bat 同一条链路）；
//   - --raptor-selftest：不进对话，跑 app\scripts\doctor.mjs 只读自检后退出（打包脚本用）。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;

internal static class Launcher
{
    private const string Version = "__RAPTOR_VERSION__"; // package-exe.mjs 构建时替换
    private const string TopDir = "CourseRaptor";        // 与 package-portable.mjs 的 PORTABLE_TOP_DIR 对齐
    private const string MarkerFile = ".portable-version";
    private const string ResourceId = "raptor.portable.zip";

    private static int Main(string[] args)
    {
        bool selfTest = args.Length > 0 && args[0] == "--raptor-selftest";
        if (args.Length > 0 && args[0] == "--version")
        {
            Console.WriteLine(Version);
            return 0;
        }

        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }
        SetConsoleOutputCP(65001); // 对齐 start.bat 的 chcp 65001：中文/emoji 不乱码
        SetConsoleCP(65001);
        Console.Title = "CourseRaptor " + Version;

        string root = InstallRoot();
        string marker = Path.Combine(root, MarkerFile);
        try
        {
            string installed = File.Exists(marker) ? File.ReadAllText(marker).Trim() : "";
            if (installed != Version)
            {
                Console.WriteLine("🦖 CourseRaptor " + Version + " 首次启动：正在释放文件到");
                Console.WriteLine("   " + root);
                Console.WriteLine("   （约 110MB，稍等一会儿；之后每次启动都是秒开）");
                int n = ExtractEmbedded(root);
                File.WriteAllText(marker, Version);
                Console.WriteLine("   释放完成，共 " + n + " 个文件。");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[!] 释放文件失败：" + ex.Message);
            Console.WriteLine("    目标目录：" + root);
            Console.WriteLine("    可把 exe 换到有写入权限的位置（如 D 盘、桌面）再运行；仍失败可删除该目录后重试。");
            return Fail(selfTest, 1);
        }

        string node = Path.Combine(root, "runtime", "node.exe");
        string entry = selfTest
            ? Path.Combine(root, "app", "scripts", "doctor.mjs")
            : Path.Combine(root, "app", "bin", "raptor.cjs");
        if (!File.Exists(node) || !File.Exists(entry))
        {
            Console.WriteLine("[!] 安装不完整（缺少 " + (File.Exists(node) ? entry : node) + "）。");
            Console.WriteLine("    请重新下载 exe 再运行；仍失败可删除目录后重试：" + root);
            return Fail(selfTest, 1);
        }

        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + entry + "\"");
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.Combine(root, "app");
        using (Process p = Process.Start(psi))
        {
            p.WaitForExit();
            if (p.ExitCode != 0) return Fail(selfTest, p.ExitCode);
        }
        if (selfTest) Console.WriteLine("[selftest] OK");
        return 0;
    }

    /// <summary>
    /// 安装目录 = exe 旁边（绿色便携语义：exe 放哪、文件就释放到哪）：
    ///   - exe 直接放在名为 CourseRaptor 的文件夹里 → 就用该文件夹（绿色版 zip 用户原地升级）；
    ///   - 否则 → exe 旁边建 CourseRaptor 子文件夹，不污染 exe 所在目录；
    ///   - RAPTOR_PORTABLE_HOME 环境变量仍可整体重定向。
    /// </summary>
    private static string InstallRoot()
    {
        string custom = Environment.GetEnvironmentVariable("RAPTOR_PORTABLE_HOME");
        if (!string.IsNullOrEmpty(custom)) return Path.GetFullPath(custom);
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if (string.Equals(Path.GetFileName(exeDir.TrimEnd('\\')), TopDir, StringComparison.OrdinalIgnoreCase))
            return exeDir;
        return Path.Combine(exeDir, TopDir);
    }

    /// <summary>释放内置 zip；条目剥掉顶层 CourseRaptor/ 前缀后落到 root 下。</summary>
    private static int ExtractEmbedded(string root)
    {
        string rootFull = Path.GetFullPath(root);
        int n = 0;
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceId))
        {
            if (s == null) throw new IOException("内置数据缺失（" + ResourceId + "）");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string name = e.FullName;
                    if (name.StartsWith(TopDir + "/", StringComparison.Ordinal)) name = name.Substring(TopDir.Length + 1);
                    if (name.Length == 0 || name.EndsWith("/", StringComparison.Ordinal)) continue;
                    string dest = Path.GetFullPath(Path.Combine(root, name));
                    // zip-slip 防线：任何条目都必须落在安装目录内
                    if (!dest.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("压缩包条目越界：" + e.FullName);
                    // 不用 \\?\ 长路径前缀：.NET Framework 的路径校验会把其中的 '?' 当非法字符；
                    // 条目深度由打包脚本构建期把关（相对路径 ≤150 字符，默认安装根下远小于 260）。
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (Stream es = e.Open())
                    using (Stream fs = File.Create(dest))
                    {
                        es.CopyTo(fs);
                    }
                    n++;
                }
            }
        }
        return n;
    }

    private static int Fail(bool selfTest, int code)
    {
        if (!selfTest && Environment.UserInteractive)
        {
            Console.WriteLine("按任意键关闭...");
            try { Console.ReadKey(true); } catch { }
        }
        return code == 0 ? 1 : code;
    }

    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleOutputCP(uint codePage);

    [DllImport("kernel32.dll")]
    private static extern bool SetConsoleCP(uint codePage);
}
