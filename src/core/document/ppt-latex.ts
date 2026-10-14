/**
 * 公式渲染：LaTeX → OMML（PPTX 内嵌可编辑公式）+ LaTeX → MathML（网页预览）。
 *
 * 照抄 OpenMAIC 的导出管线（MIT / THU-MAIC）：
 * LaTeX → MathML（temml）→ 清掉 mathml2omml 不认的标签 → OMML
 * （mathml2omml）→ 注入 Cambria Math 字体属性。OMML 由渲染器写进
 * slide XML 的 <mc:AlternateContent>（PowerPoint 里是可编辑公式，
 * 不是图片）。
 *
 * 安全面：temml 不认的输入不抛错（throwOnError:false），产出错误
 * 色 span 由调用方按「转换失败」降级；宏定义类命令 temml 本就不
 * 支持，trust 关闭，模型给的公式串按纯数据对待。
 */

import { mml2omml } from "mathml2omml";
import temml from "temml";

/** mathml2omml 不支持的 MathML 标签：剥掉标签留内容 */
function stripUnsupportedMathML(mathml: string): string {
  let result = mathml;
  for (const tag of ["mpadded"]) {
    result = result.replace(new RegExp(`<${tag}[^>]*>`, "g"), "");
    result = result.replace(new RegExp(`</${tag}>`, "g"), "");
  }
  return result;
}

/** 数学 run 的字体属性：PowerPoint 公式必须 Cambria Math */
function buildMathRPr(szHundredths?: number): string {
  const szAttr = szHundredths ? ` sz="${szHundredths}"` : "";
  return (
    `<a:rPr lang="en-US" i="1"${szAttr}>` +
    '<a:latin typeface="Cambria Math" panose="02040503050406030204" charset="0"/>' +
    '<a:cs typeface="Cambria Math" panose="02040503050406030204" charset="0"/>' +
    "</a:rPr>"
  );
}

/** OMML 后处理：剥 DOCX 专用命名空间声明，给每个数学 run 补字体属性 */
function postProcessOmml(omml: string, szHundredths?: number): string {
  const rpr = buildMathRPr(szHundredths);
  let result = omml;
  result = result.replace(/ xmlns:w="[^"]*"/g, "");
  result = result.replace(/<m:r>(\s*)<m:t/g, `<m:r>$1${rpr}$1<m:t`);
  result = result.replace(/<m:ctrlPr\/>/g, `<m:ctrlPr>${rpr}</m:ctrlPr>`);
  result = result.replace(/<m:ctrlPr><\/m:ctrlPr>/g, `<m:ctrlPr>${rpr}</m:ctrlPr>`);
  return result;
}

/**
 * LaTeX → OMML XML 字符串（一个 <m:oMath> 元素）。失败返回 null，
 * 调用方降级为纯文本。注入 slide XML 时命名空间由注入方内联声明
 * （mathml2omml 的产物自带 xmlns:m/xmlns:w，前者保留、后者剥掉）。
 *
 * @param latex LaTeX 源码（不带 $ 定界符）
 * @param fontSizePt 字号（磅）；写入每个 run 的 sz（百分之一磅）
 */
export function latexToOmml(latex: string, fontSizePt?: number): string | null {
  const src = latex.trim();
  if (!src) return null;
  try {
    const mathml = temml.renderToString(src, {
      displayMode: true,
      annotate: false,
      throwOnError: false,
      trust: false,
    });
    const cleaned = stripUnsupportedMathML(mathml);
    const omml = String(mml2omml(cleaned));
    if (!omml.includes("<m:oMath")) return null;
    const szHundredths = fontSizePt ? Math.round(fontSizePt * 100) : undefined;
    return postProcessOmml(omml, szHundredths);
  } catch {
    return null;
  }
}

/**
 * LaTeX → MathML 字符串（网页预览用，浏览器原生渲染）。
 * 与 OMML 路径同源，失败返回 null（预览侧降级为源码文本）。
 */
export function latexToMathML(latex: string): string | null {
  const src = latex.trim();
  if (!src) return null;
  try {
    return temml.renderToString(src, {
      displayMode: true,
      annotate: false,
      throwOnError: false,
      trust: false,
    });
  } catch {
    return null;
  }
}
