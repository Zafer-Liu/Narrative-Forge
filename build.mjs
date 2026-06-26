// Narrative Forge 前端构建脚本（仅开发期使用）
// 用 esbuild 把 static/src/main.js 打包为 static/dist/bundle.js（含 sourcemap、压缩）。
// 运行时仍是零依赖静态文件，由 Python http.server 直接托管。
import { build, context } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, "static/dist");
const watch = process.argv.includes("--watch");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(root, "static/src/main.js")],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  sourcemap: true,
  minify: !watch,
  outfile: resolve(outdir, "bundle.js"),
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[esbuild] watching static/src → static/dist/bundle.js");
} else {
  await build(options);
  console.log("[esbuild] built static/dist/bundle.js");
}
