# AGENTS.md

## Git 工作流

- PR 合并后立即删除远程 feature 分支（`git push origin --delete <branch>`），同步清理本地分支。此规则无需用户提醒，每次 PR 合并后必须主动执行；远程已自动删除时用 `git fetch --prune` 修剪本地引用。
- 本地 main 在 PR 合并后复位到 origin/main，不要在 main 上直接累积提交。
- 仅删除「已合并」的分支：PR 被关闭未合并、或分支内容尚未进 main 的，一律保留并说明情况。
- `feat/hebau-school-adapter` 是用户明确要求保留的进行中分支，先不动它（不删、不合并、不重排），直至用户另行指示或其合入 main。
