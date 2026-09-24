# NJTech 教务协议与运维须知（njtech-jwgl 技能参考）

面向需要维护或排障本技能的人：南京工业大学教务系统的接入方式、限流、重试与模块边界。

## 一、涉及的域名

| 域名 | 用途 | 是否需要登录 |
|------|------|--------------|
| `jwgl.njtech.edu.cn` | 正方教务主站：课表/成绩/考试/学籍/选课 | 是（RSA + CSRF） |
| `jwc.njtech.edu.cn` | 教务处官网：公告通知/教学动态/考试排课 | 否（公开页面） |
| 其它 `*.njtech.edu.cn` | 通知正文/附件（read_notice / fetch_attachment） | 部分受限（权限文章匿名 302 到 auth.htm） |

> 技能脚本与工具均只对 `njtech.edu.cn` 域名生效；跨域请求会被拒绝。

## 二、登录与会话

- **登录流程**（`jwgl/auth.loginJwgl`）：RSA 加密密码 + CSRF token 获取，逆向自正方新版前端。
- **普通会话 cookie**：登录后缓存 25 分钟（`AUTH_TTL_MS`），失效或强制时重建；带 5 次指数退避重试
  （密码/学号错误不重试，直接报错）。
- **选课会话**（`jwgl/xk.openXkSession`）：额外携带 `xkkzId` / `csrftoken` 与预热轮次上下文，同样 25 分钟缓存。
- 选课提交必须与查询**同源轮次凭证**（`kklxdm` / `xkkzId` / `xkkzXh`），跨轮次会被服务端拒绝或返回空。

## 三、限流与重试（礼貌边界，务必遵守）

- **全局令牌桶**在传输层（`jwgl/http.createClient`）：默认 `RAPTOR_MAX_RPS=3`，突发 `RAPTOR_BURST=8`。
  **只允许下调，严禁调高**——避免打爆教务系统或被 WAF 盯上。
- **登录重试**：5 次，间隔 `attempt*2s`。
- **单学期成绩查询**：3 次重试；连续失败该学期计入 `failedTerms` 如实上报，不静默吞掉。
- **重定向上限**：5 跳（正方失效时 302 回登录页，防无限循环）。
- **请求超时**：30s；选课轮询含 ±20% 随机抖动（避免被精确识别）。

## 四、正方模块覆盖（55 个菜单模块）

- **已接入（可用）**：课表、成绩、GPA、考试、实验成绩、学籍、已选教学班、可重修、选课（自主选课）、
  通知、通知正文、附件。
- **学校侧停用（任何客户端均不可用）**：空闲教室、班级课表、学业情况、实验课表、培养方案等约 6 个
  （返回「系统维护页面」）。
- **未接入**：申请/流程类 30+ 项（如休学/转专业办理）。

## 五、安全红线

- **真实写操作**（`grab_course` / `grab_plan` / `drop_course`）会真实提交选课系统，**仅经交互式 agent、
  且用户明确点名目标并二次确认后才可调用**；绝不批量退课。技能脚本 `query.ts` 不提供这些命令。
- **隐私**：学籍敏感字段（证件号/银行卡/考生号）返回即打码；本地 `credentials.enc` / `session.json` /
  `memory.json` / `qq-allowlist.json` 切勿分享。
- **验证码 OCR**：仅用于获取本人有权访问的通知附件，本地 tesseract；停用设 `RAPTOR_DISABLE_CAPTCHA_OCR=1`。
- **免责**：本项目与南京工业大学官方无关，使用者自担风险，遵守教务系统使用条款，避免高频请求。

## 六、目录与依赖

- 协议层：`src/adapters/njtech/`（http, session, auth, crypto, academics, grades, portal, news, xk, term-dates, term-holidays, types）
- 工具封装：`src/adapters/njtech/tools/`（schedule, grades, news, student, course-selection）
- 本技能只读封装上述模块，运行依赖 `tsx`（devDependency）与项目内 `node_modules`。
