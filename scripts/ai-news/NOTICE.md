# AI News 引擎来源

源仓库：https://github.com/Health-525/ai-news-skills

基线版本：`4688ee63c3bc14de1fede1fcc35154a4176c9a20`（本地工作区快照）。保留 MIT 许可。

仅移植采集、事件排序、来源验证与趋势能力；移除了投递、审批、字幕请求和运行时订阅。`digest.py` 仅保留校验；`storage.py` 仅保留采集相关表与方法；`workflow.py` 使用独立状态目录和静态来源配置；趋势报告不包含用户反馈。新增入口 `news.py` 负责 CourseRaptor 的分页、摘要草稿与冻结日报。
