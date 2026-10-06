# CourseRaptor 管理台（前端）

网关 `/admin` 的 React 单页应用，基于 [shadcn-admin v2.2.1](https://github.com/satnaing/shadcn-admin)（MIT）裁剪：
React 19 + Vite 7 + Tailwind v4 + shadcn/ui + TanStack Router/Query/Table。后端接口见 `gateway/admin/ui.mjs`（本目录不含任何服务端逻辑）。

## 与部署的关系（重要）

- **构建产物 `admin/dist` 随仓库提交**。服务器升级流程不变：`git pull && systemctl restart raptor-gateway`，网关直接下发 `admin/dist`，服务器上不需要 Node 构建链。
- CI 的 `admin-web` job 会重新构建并 `git diff` 校验 dist 与源码一致——**改完前端必须重新构建并连同 dist 一起提交**，否则 CI 红灯。

## 开发

```bash
cd admin
npm install        # 独立 npm 包，不影响根工程
npm run dev        # http://localhost:5173/admin/，API 自动代理到本机网关 8080
                  # （根目录 npm run gateway 起网关，管理台密码走 GATEWAY_ADMIN_PASSWORD）
npm run lint
npm run build      # tsc -b && vite build → 产出 dist/
```

## 目录速览

```
src/
  routes/            TanStack Router 文件路由（_authenticated/ 下 11 个功能页 + 错误页 + (auth)/sign-in）
  features/          页面实现：dashboard / users / invites / resets / site / security / release / keys / log / token-usage / local-usage / auth / errors
  components/        布局（侧栏/页头）、data-table 套件、确认弹窗
  lib/api.ts         全部后端接口客户端 + 数据类型（与 ui.mjs 响应一一对应）
  lib/admin-data.ts  bootstrap 单请求查询（60s 轮询，与旧管理台同模式）
```

页面文案全部为简体中文；深浅色主题、移动端侧栏抽屉为模板自带能力。

## 裁剪记录（相对 shadcn-admin 模板）

删除：Clerk 演示、apps/chats/help-center/tasks/users 演示页、settings、faker、recharts、Google Fonts 外链（改系统字体栈）、Vitest 浏览器测试；swc 插件换成 @vitejs/plugin-react（本机 swc 原生绑定不可用，纯 JS 插件跨平台更稳）。

2026-10 精简轮追加删除：英文主题配置抽屉（ConfigDrawer）、假搜索框 + ⌘K 命令面板（Search/CommandMenu/SearchProvider）、页头头像下拉（ProfileDropdown，与侧栏底部用户菜单重复）、ComingSoon/LearnMore/TopNav/Clerk logo/brand-icons 社媒图标/custom 布局图标等无引用资产；概览页永久禁用的「状态」假 tab 一并拆除。页头统一为 AdminHeader（运行信息 + 刷新 + 主题切换），错误页（401/403/404/500/503）、data-table 工具栏（列显示/分页/清除选择）与主题菜单全部汉化。
