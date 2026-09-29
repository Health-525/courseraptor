# courseraptor-web

CourseRaptor 的官网落地页（React + Vite，纯静态、虚构示例数据，不连接教务系统或模型服务，不含任何密钥），同时作为导入 [QMuse](https://docs.qmuse.cn/docs/qmuse-cli) 平台的前端载体（QMuse CLI 仅支持 React 项目）。

官网由 `.github/workflows/landing-pages.yml` 自动构建并发布到 GitHub Pages（子路径 `/courseraptor/`，构建时注入 `PAGES_BASE`）；根路径构建（如 qmuse 导入）无需设置该变量。

## 开发

```bash
npm install
npm run dev      # 本地开发
npm run build    # 构建，导入 QMuse 前需保证构建通过
```

## 导入 QMuse

```bash
qmuse login                       # 浏览器确认登录
qmuse space list                  # 列出空间
qmuse space use <空间ID>
qmuse import .                    # 在本目录执行；之后再次 import 会在同一应用下新增版本
```

说明：

- 导入时 CLI 会强制排除 `.env`/`.env.*`，并遵循 `.gitignore`，密钥不会被上传。
- 首次导入成功后会生成 `.qmuse/project.json`（应用绑定关系，已加入 `.gitignore`，不要删除或跨项目复制）。
