# AGENTS.md

## Git 工作流

- PR 合并后立即删除远程 feature 分支（`git push origin --delete <branch>`），同步清理本地分支。
- 本地 main 在 PR 合并后复位到 origin/main，不要在 main 上直接累积提交。
