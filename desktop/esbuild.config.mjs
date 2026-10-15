import builtinModules from "builtin-modules";
import esbuild from "esbuild";

/**
 * 打包 Electron 主进程与预加载脚本为 CJS（Electron main 不能直接跑 TS）。
 * 参考 obsidian/esbuild.config.mjs 的写法：external 掉 electron 与 node 内置。
 * electron-updater 也 external——它是运行期按需 require 的可选依赖。
 */

const prod = process.argv[2] === "production";

const external = [
  "electron",
  "electron-updater",
  ...builtinModules.flatMap((m) => [`node:${m}`, m]),
];

const context = await esbuild.context({
  entryPoints: ["src/main.ts", "src/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external,
  outdir: "dist",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
}
await context.watch();
