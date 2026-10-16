import builtinModules from "builtin-modules";
import esbuild from "esbuild";

/**
 * 打包 Electron 主进程与预加载脚本为 CJS（Electron main 不能直接跑 TS）。
 * 参考 obsidian/esbuild.config.mjs 的写法：external 掉 electron 与 node 内置。
 * electron-updater 也 external：electron-builder 会按 package.json 的
 * dependencies 自动把生产依赖（含 electron-updater 整条依赖链）拷进
 * resources/app/node_modules，运行期 require 直接可用——这是 electron-builder
 * 的标准行为，不需要也不应该 bundle。曾试过打进 dist/main.js：graceful-fs 等
 * CJS 库的顶层副作用（monkey-patch process.cwd）被内联进主进程脚本，导致
 * 安装版启动卡死（无窗口、不报错），已推翻。
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
