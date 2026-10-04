/**
 * PPT 构建代码沙箱测试（ppt_preview / ppt_save 的底座）
 *
 * 钉住四件事：
 * 1. 录音正确性：变量/循环/主题色常量写出的代码录成与手写等价的 op 程序；
 * 2. 边界：BANNED 黑名单、页数/要点/元素上限与 warnings、坐标越界裁回、
 *    参数错误抛中文消息且保留报错前的半成品（preview 可定位、save 拒绝）；
 * 3. 渲染保真：renderPptxProgram 解包断言品牌母版/朱砂封面/楷体/自由页元素
 *    真的写进 XML 字节；
 * 4. 工具接线：ppt_preview 不落盘、ppt_save 落盘并带 ppt 预览载荷（网页翻页卡）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-pptcode-"));
process.env.RAPTOR_DATA_DIR = tmpData;

const require = createRequire(import.meta.url);

import { PPT_LIMITS, runPptCode, validateProgram } from "../src/core/document/ppt-program";
import {
  buildProgramPreview,
  PREVIEW_ELEM_CAP,
  pptPreviewOfToolOutput,
  renderPptxProgram,
} from "../src/core/document/pptx-theme";

test("runPptCode：循环/变量/主题色录成 op 程序", () => {
  const r = runPptCode(`
    pptx.cover({ title: "期末复习", author: "小明" });
    pptx.section("第一章 极限");
    const chapters = [["极限", ["定义", "计算"]], ["微分", ["几何意义"]]];
    for (const [name, points] of chapters) {
      pptx.bullets({ title: name, points: points, notes: "讲 " + name });
    }
    pptx.table({ title: "公式表", headers: ["式", "值"], rows: [["e", 2.718]] });
  `);
  assert.equal(r.ok, true, r.error ?? "runPptCode 应成功");
  const ops = r.program!.ops;
  assert.equal(ops.length, 5);
  assert.deepEqual(ops[0], { op: "cover", title: "期末复习", author: "小明" });
  assert.equal(ops[1].op, "section");
  if (ops[2].op === "bullets") {
    assert.deepEqual(ops[2].points, ["定义", "计算"]);
    assert.equal(ops[2].notes, "讲 极限");
  } else assert.fail("第 3 页应为 bullets");
  if (ops[4].op === "table") {
    assert.deepEqual(
      ops[4].rows,
      [["e", "2.718"]],
      "数字单元格应归一为字符串（渲染层同款 String 化）",
    );
    assert.deepEqual(ops[4].headers, ["式", "值"]);
  } else assert.fail("第 5 页应为 table");
});

test("runPptCode：blank 自由页元素、主题色名解析、W/H 常量", () => {
  const r = runPptCode(`
    const s = pptx.blank("时间线");
    s.text("第一步", { x: 0.5, y: 1.2, w: 3, h: 0.5, size: 18, color: "accent", bold: true, align: "center", font: "kai" });
    s.shape("ellipse", { x: 4.9, y: 2.8, w: 0.2, h: 0.2, fill: pptx.theme.accent });
    s.shape("line", { x: 0.5, y: 3.05, w: 9, h: 0, line: pptx.theme.rule, lineW: 2 });
    s.logo({ x: 9.2, y: 4.9, w: 0.4, h: 0.4 });
    s.notes("流程讲解");
    console.log("画布", pptx.W + "x" + pptx.H);
  `);
  assert.equal(r.ok, true, r.error ?? "runPptCode 应成功");
  const op = r.program!.ops[0];
  assert.equal(op.op, "blank");
  assert.equal(op.title, "时间线");
  assert.equal(op.notes, "流程讲解");
  assert.equal(op.elements.length, 4);
  const [text, dot, line, logo] = op.elements as any[];
  assert.equal(text.color, "AD392C", "主题色名 accent 应解析成朱砂");
  assert.equal(text.bold, true);
  assert.equal(text.font, "kai");
  assert.equal(dot.fill, "AD392C");
  assert.equal(line.kind, "line");
  assert.equal(logo.kind, "logo");
  assert.ok(
    r.logs?.some((l) => l.includes("10x5.625")),
    "console.log 应取回",
  );
});

test("runPptCode：BANNED 黑名单与空代码", () => {
  const bad = runPptCode('pptx.cover({ title: "x" }); const p = process;');
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /禁用「process」/);
  assert.equal(runPptCode("").ok, false);
  assert.match(runPptCode("1 + 1").error!, /没有构建任何一页/);
});

test("runPptCode：上限 warnings + 越界裁回", () => {
  const fat = runPptCode(`
    for (let i = 0; i < ${PPT_LIMITS.slides + 3}; i++) pptx.section("第" + i + "章");
  `);
  assert.equal(fat.ok, true);
  assert.equal(fat.program!.ops.length, PPT_LIMITS.slides, "页数应封顶");
  assert.ok(
    fat.warnings?.some((w) => w.includes("页数超过")),
    "应有页数超限警告",
  );

  const manyBullets = runPptCode(
    `pptx.bullets({ title: "多", points: Array.from({length: ${PPT_LIMITS.bullets + 5}}, (_, i) => "点" + i) })`,
  );
  assert.equal(manyBullets.ok, true);
  if (manyBullets.program!.ops[0].op === "bullets")
    assert.equal(manyBullets.program!.ops[0].points.length, PPT_LIMITS.bullets);

  const out = runPptCode('const s = pptx.blank(); s.text("越界", { x: 9.5, y: 5.5, w: 3, h: 1 });');
  assert.equal(out.ok, true);
  const el = (out.program!.ops[0].op === "blank" ? out.program!.ops[0].elements[0] : null) as any;
  assert.equal(el.x + el.w, 10, "右边越界应裁回画布右缘");
  assert.equal(el.y + el.h, 5.625, "下边越界应裁回画布下缘");
  assert.ok(out.warnings?.some((w) => w.includes("超出画布")));
});

test("runPptCode：参数错误抛中文消息，且保留报错前已录页", () => {
  const r = runPptCode(`
    pptx.cover({ title: "好的" });
    pptx.bullets({ title: "缺要点", points: "不是数组" });
  `);
  assert.equal(r.ok, false);
  assert.match(r.error!, /points 必须是字符串数组/);
  assert.equal(r.program?.ops.length, 1, "报错前的封面应保留（供 preview 定位）");

  const color = runPptCode(
    'const s = pptx.blank(); s.text("x", { x:0, y:0, w:1, h:0.5, color: "红色" });',
  );
  assert.equal(color.ok, false);
  assert.match(color.error!, /颜色不合法/);
});

test("validateProgram：宿主 zod 拒绝篡改/畸形 op（纵深防御）", () => {
  assert.equal(validateProgram({ ops: [{ op: "hack" }] }).ok, false);
  assert.equal(validateProgram({ ops: [{ op: "cover", title: "" }] }).ok, false, "空标题不行");
  assert.equal(
    validateProgram({
      ops: [{ op: "blank", elements: [{ kind: "text", x: -1, y: 0, w: 1, h: 1, text: "x" }] }],
    }).ok,
    false,
    "负坐标不行",
  );
  assert.equal(
    validateProgram({
      ops: [
        {
          op: "blank",
          elements: [{ kind: "text", x: 0, y: 0, w: 1, h: 1, text: "x", color: "XYZ" }],
        },
      ],
    }).ok,
    false,
    "非十六进制颜色不行",
  );
});

test("renderPptxProgram：品牌与自由页元素写进 XML 字节", async () => {
  const r = runPptCode(`
    pptx.cover({ title: "开题答辩", author: "李雷" });
    pptx.section("第一章 背景");
    pptx.bullets({ title: "研究意义", points: ["效率提升", "门槛降低"], notes: "备注甲" });
    const s = pptx.blank("进度安排");
    s.text("三月开题", { x: 0.6, y: 2, w: 3, h: 0.6, size: 20, color: pptx.theme.accent, bold: true });
    s.shape("line", { x: 0.6, y: 2.8, w: 8.8, h: 0, line: pptx.theme.ink3, lineW: 1.5 });
  `);
  assert.equal(r.ok, true, r.error ?? "runPptCode 应成功");
  const buf = await renderPptxProgram(r.program!);
  assert.ok(
    buf.length > 4 && buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    "pptx 应是 zip",
  );

  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  const slideXmls = await Promise.all(
    names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort()
      .map((n) => zip.files[n].async("string")),
  );
  const slides = slideXmls.join("\n");
  const all = slides + (await zip.files["ppt/slideLayouts/slideLayout2.xml"].async("string"));
  // 封面：楷体标题 + 朱砂 + 印章媒体；章节页/要点页正文；自由页自定义元素与备注
  assert.ok(slides.includes("KaiTi"));
  assert.match(slides, /开题答辩|三月开题/);
  assert.ok(slides.includes("AD392C"), "朱砂（自由页文本/圆点）应写入");
  assert.ok(slides.includes("三月开题"));
  assert.ok(slides.includes("研究意义"));
  assert.ok(all.includes("COURSERAPTOR") || slides.includes("COURSERAPTOR"), "母版页脚品牌字");
  assert.ok(slides.includes("a:line") || slides.includes("line"), "line 形状应写入");
  const notes = await Promise.all(
    names
      .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
      .map((n) => zip.files[n].async("string")),
  );
  assert.match(notes.join("\n"), /备注甲/);
  // 媒体去重：封面印章 + 内容页母版落款同一份 logo 合并
  const media = names.filter((n) => /^ppt\/media\/[^/]+$/.test(n));
  assert.equal(media.length, 1, `重复 logo 应合并为一份，实为 ${media.join(", ")}`);
});

test("buildProgramPreview：free 页元素镜像 + 截断上限 + 校验闸", () => {
  const r = runPptCode(`
    pptx.cover({ title: "预览" });
    const s = pptx.blank();
    for (let i = 0; i < ${PREVIEW_ELEM_CAP + 5}; i++) s.text("元素" + i, { x: 0.5, y: 0.3 + i * 0.08, w: 4, h: 0.3 });
  `);
  assert.equal(r.ok, true, r.error ?? "runPptCode 应成功");
  const pv = buildProgramPreview(r.program!);
  assert.equal(pv.count, 2);
  const free = pv.slides[1];
  assert.equal(free.kind, "free");
  assert.equal(free.elements!.length, PREVIEW_ELEM_CAP, "预览元素封顶");
  assert.equal(free.elemCut, 5);

  // 校验闸：合法 free 载荷放行（SSE 链路），畸形元素拒绝
  const good = pptPreviewOfToolOutput({ ppt: { count: 1, slides: [free] } });
  assert.ok(good, "合法 free 页应过闸");
  assert.equal(good!.slides[0].elements!.length, PREVIEW_ELEM_CAP);
  assert.equal(
    pptPreviewOfToolOutput({
      ppt: {
        count: 1,
        slides: [{ kind: "free", elements: [{ kind: "text", x: 0, y: 0, w: 1, h: 1 }] }],
      },
    }),
    null,
    "缺 text 的元素应整份拒绝",
  );
  assert.equal(
    pptPreviewOfToolOutput({
      ppt: {
        count: 1,
        slides: [{ kind: "free", elements: [{ kind: "bomb", x: 0, y: 0, w: 1, h: 1 }] }],
      },
    }),
    null,
    "未知元素类型应拒绝",
  );
});

test("工具接线：ppt_preview 干跑不落盘、ppt_save 落盘带 ppt 载荷", async () => {
  const { coreTools } = await import("../src/core/tools");
  const preview = (coreTools.ppt_preview as unknown as { execute: (i: unknown) => Promise<any> })
    .execute;
  const save = (coreTools.ppt_save as unknown as { execute: (i: unknown) => Promise<any> }).execute;
  const code = `
    pptx.cover({ title: "工具层课件", author: "测试" });
    pptx.bullets({ title: "要点", points: ["一", "二"] });
    const s = pptx.blank(); s.text("自由行", { x: 0.6, y: 2, w: 5, h: 0.5, size: 16 });
  `;

  const p = await preview({ code });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.slides, 3);
  assert.equal(p.pages.length, 3);
  assert.equal(p.pages[0], "1. [封面] 工具层课件");
  assert.equal(p.pages[2], "3. [自由] （1 元素）");
  const genDir = path.join(tmpData, "generated");
  assert.ok(!fs.existsSync(genDir) || fs.readdirSync(genDir).length === 0, "干跑不应落盘");

  const g = await save({ code, filename: "代码课件" });
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.match(g.filename, /^代码课件.*\.pptx$/);
  assert.ok(fs.existsSync(g.path));
  assert.ok(g.ppt, "save 应带网页翻页预览载荷");
  assert.equal(g.ppt.count, 3);
  assert.equal(g.ppt.slides[0].kind, "cover");
  assert.equal(g.ppt.slides[2].kind, "free");
  // files 字段形状与 generate_document 一致（chat-web filesOfToolOutput 靠它出下载行）
  assert.equal(typeof g.path, "string");
  assert.equal(typeof g.bytes, "number");

  // 报错代码：save 拒绝半成品，preview 给出定位信息
  const broken = `
    pptx.cover({ title: "半成品" });
    pptx.section("");
  `;
  const pb = await preview({ code: broken });
  assert.equal(pb.ok, false);
  assert.equal(pb.slides, 1);
  const gb = await save({ code: broken });
  assert.equal(gb.ok, undefined);
  assert.match(gb.error!, /title 不能为空/);
  assert.match(gb.note!, /半成品/);
});
