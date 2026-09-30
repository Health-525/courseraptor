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
  routes/            TanStack Router 文件路由（_authenticated/ 下 9 个页面 + (auth)/sign-in）
  features/          页面实现：overview / users / invites / resets / site / security / release / keys / log / auth
  components/        布局（侧栏/页头）、data-table 套件、确认弹窗、命令面板（模板保留件）
  lib/api.ts         全部后端接口客户端 + 数据类型（与 ui.mjs 响应一一对应）
  lib/admin-data.ts  bootstrap 单请求查询（60s 轮询，与旧管理台同模式）
```

页面文案全部为简体中文；深浅色主题、移动端侧栏抽屉为模板自带能力。

## 裁剪记录（相对 shadcn-admin 模板）

删除：Clerk 演示、apps/chats/help-center/tasks/users 演示页、settings、faker、recharts、Google Fonts 外链（改系统字体栈）、Vitest 浏览器测试；swc 插件换成 @vitejs/plugin-react（本机 swc 原生绑定不可用，纯 JS 插件跨平台更稳）。
