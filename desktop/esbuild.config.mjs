import builtinModules from "builtin-modules";
import esbuild from "esbuild";

/**
 * 打包 Electron 主进程与预加载脚本为 CJS（Electron main 不能直接跑 TS）。
 * 参考 obsidian/esbuild.config.mjs 的写法：external 掉 electron 与 node 内置。
 * electron-updater 则打进包内：electron-builder 的拷贝过滤对目录名 node_modules
 * 是整棵硬丢弃（见 src/payload.ts 注释），外部 node_modules 进包必然缺件，
 * 自动更新会在安装版静默失效；打进 dist/main.js 即无此问题（纯 JS 依赖，可 bundle）。
 */

const prod = process.argv[2] === "production";

const external = [
  "electron",
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
