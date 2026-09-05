// 固定演示文本不接受外部输入，也不调用教务系统或模型服务。
const answers = {
  schedule: {
    question: "这周有什么课？",
    html: '<h3>这一周，先帮你整理好了。</h3><div class="schedule-row"><span>周一<small>1–2 节</small></span><div>示例高等数学<small>示例教学楼 101</small></div></div><div class="schedule-row"><span>周三<small>3–4 节</small></span><div>示例大学英语<small>示例教学楼 202</small></div></div><div class="schedule-row"><span>周五<small>7–8 节</small></span><div>示例程序设计<small>示例机房</small></div></div><p class="answer-note">以上全部为虚构数据。正式查询会结合你的教学周和已记录的调休安排。</p>',
  },
  credits: {
    question: "通识修了哪些类别？",
    html: '<h3>先按已通过的课程，帮你汇总。</h3><div class="schedule-row"><span>人文类</span><div>2 学分<small>虚构示例 · 已通过</small></div></div><div class="schedule-row"><span>自然类</span><div>2 学分<small>虚构示例 · 已通过</small></div></div><div class="schedule-row"><span>艺术类</span><div>0 学分<small>虚构示例 · 尚未覆盖</small></div></div><p class="answer-note">未通过和待出分课程不计已获学分。类别覆盖不等于满足最低学分，具体要求请对照本人培养方案。</p>',
  },
  calendar: {
    question: "怎么导入手机日历？",
    html: '<h3>三步，把安排放进口袋里。</h3><ol><li>在正式助手里提问：把本学期课表和考试导出为 .ics 文件。</li><li>生成后，从本地网页对话中下载日历文件。</li><li>导入你的手机日历；安排变更后重新导出与同步。</li></ol><p class="answer-note">这里仅展示操作说明，没有生成或公开任何文件。自动订阅需要另行配置发布渠道，当前订阅源公开可见。</p>',
  },
};

for (const button of document.querySelectorAll("[data-example]")) {
  button.addEventListener("click", () => {
    const answer = answers[button.dataset.example];
    if (!answer) return;
    for (const other of document.querySelectorAll("[data-example]")) other.setAttribute("aria-pressed", String(other === button));
    document.querySelector("#example-question").textContent = answer.question;
    document.querySelector("#example-answer").innerHTML = '<p class="answer-label">🦖 小恐龙</p>' + answer.html;
  });
}

document.querySelector("#copy-command").addEventListener("click", async () => {
  const status = document.querySelector("#copy-status");
  try {
    await navigator.clipboard.writeText(document.querySelector("#commands").textContent);
    status.textContent = "已复制，在解压后的项目目录运行即可。";
  } catch {
    status.textContent = "浏览器未允许复制，请选中上方三条命令手动复制。";
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#commands"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
