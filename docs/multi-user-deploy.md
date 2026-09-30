# 多用户网关部署手册（班级共用版）

把 CourseRaptor 以「一人一实例」的方式部署到一台公网服务器上：同学浏览器
打开网址 → 邀请码注册 → 登录后就是完整的网页版（课表/成绩/待办/对话），
各自的数据与教务凭证完全隔离。本地版（终端 TUI / 安装包 / QQ 机器人）
不受任何影响——网关复用的是同一套核心代码，零侵入。

```
浏览器 ── http://<服务器IP>:8080 ──> 网关（常驻，npm run gateway）
                                     ├─ /login /register（邀请码）
                                     └─ 其余请求按会话 Cookie 路由到该同学的
                                        专属实例（按需拉起、空闲回收、独立端口）
```

## 架构要点

- **网关**（`gateway/`）：登录注册、会话 Cookie（HttpOnly + SameSite=Lax
  + HMAC 签名）、登录防爆破（连续 5 次失败锁 15 分钟）、每日每人对话轮数限额、
  按用户反向代理。转发时改写 `Host`、剥掉 `Origin`，后端现有的三道本机防线
  原样通过。
- **实例**（`gateway/headless/entry.ts`）：每位同学一个 Node 子进程，靠环境变量
  隔离——`RAPTOR_DATA_DIR`（数据）、`RAPTOR_CREDENTIALS_FILE`（加密凭证）、
  `RAPTOR_WEB_PORT`（独立回环端口）。空闲 30 分钟自动回收，下次请求重新拉起
  （约 3-5 秒）。
- **DeepSeek Key 混合模式**：网关默认注入站点统一 Key；同学在网页「设置」里
  保存自己的 Key 后自动优先用自己的（现有配置解析顺序天然支持）。
- **数据**：`GATEWAY_USERS_DIR/<用户ID>/` 每人一个目录（data/ + credentials.enc），
  AES-256-GCM 加密，密钥由服务器派生。注意边界：**同一服务器上的管理员
  （你）技术上可解密**——登录页已向同学披露。
- 注册表与邀请码：`GATEWAY_STATE_DIR/users.json` + `invites.json`，密码只存
  scrypt 散列。

## 服务器要求

- Linux（Ubuntu 22.04+）、Node.js ≥ 24、2C2G 起步（1.7G 内存机型建议
  `GATEWAY_MAX_CONCURRENT=4` 并加 2G swap）、磁盘每 50 位同学预留约 2G
- 公网安全组 / 防火墙放行一个 TCP 端口（默认 8080）

## 首次部署

```bash
# 1. 安装 Node.js 24（Ubuntu，NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 低权限用户 + 代码
sudo useradd -r -m -s /bin/bash raptor
sudo git clone https://github.com/Health-525/courseraptor.git /opt/courseraptor
sudo chown -R raptor:raptor /opt/courseraptor
sudo -u raptor bash -c "cd /opt/courseraptor && npm ci"

# 3. 2G swap（小内存机型兜底）
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 4. 网关环境变量
sudo mkdir -p /var/lib/raptor-gateway /var/lib/raptor-users
sudo tee /etc/raptor-gateway.env >/dev/null <<'EOF'
GATEWAY_SECRET=<openssl rand -hex 32 生成>
GATEWAY_DEEPSEEK_KEY=<站点统一 DeepSeek Key，可留空>
GATEWAY_STATE_DIR=/var/lib/raptor-gateway
GATEWAY_USERS_DIR=/var/lib/raptor-users
GATEWAY_MAX_CONCURRENT=4
GATEWAY_IDLE_MINUTES=30
GATEWAY_DAILY_TURNS=100
EOF
sudo chown raptor:raptor /var/lib/raptor-gateway /var/lib/raptor-users
sudo chmod 600 /etc/raptor-gateway.env && sudo chown raptor:raptor /etc/raptor-gateway.env

# 5. systemd 常驻
sudo tee /etc/systemd/system/raptor-gateway.service >/dev/null <<'EOF'
[Unit]
Description=CourseRaptor multi-user gateway
After=network-online.target

[Service]
User=raptor
WorkingDirectory=/opt/courseraptor
EnvironmentFile=/etc/raptor-gateway.env
ExecStart=/usr/bin/node gateway/gateway.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now raptor-gateway

# 6. 防火墙 + 云安全组放行 8080/tcp，然后生成邀请码
sudo ufw allow 8080/tcp
cd /opt/courseraptor && sudo -u raptor GATEWAY_STATE_DIR=/var/lib/raptor-gateway \
  node gateway/admin/cli.mjs invite --count 10 --note 班级群 --days 14
```

同学拿到邀请码后访问 `http://<服务器IP>:8080/register` 注册即可。

## 日常运维

### 网页管理台（推荐）

`/etc/raptor-gateway.env` 里设置 `GATEWAY_ADMIN_PASSWORD`（至少 8 位）后，
浏览器打开 **http://<服务器IP>:8080/admin** 输密码即可。管理台与同学端
网页（`src/channels/web`）同一套「红头档案」应用壳：左侧档头栏分组导航 +
右侧滚动内容区，窄屏退回 ☰ 左抽屉；前端代码在
`gateway/admin/assets/admin-app.js`（独立资产，服务时内联进页面，单文件交付）。
八个面板按 `#/hash` 路由切换（刷新保持位置、可直达链接），页面可见时
每 60 秒自动轻量刷新一次数据：

- 总览：注册数 / 在线与并发上限 / 可用邀请码 / 今日全站对话轮数（站点 +
  自有 Key 分账）、站点 Key 三层链路状态、待审批重置直达入口
- 同学账号表：Key 来源（分账模式）、在线状态（悬停看实例启动 / 最近活跃 /
  重启次数）、今日用量（个人限额标红）、**限额 / 停用 / 启用 / 踢下线**
- 邀请码：按数量 + 备注 + 有效期生成，一键复制，档案表可见使用者绑定
- 重置审批：待审列表（同意并生成一次性码 / 拒绝）+ 有效重置码管理；
  有待审时侧栏「重置审批」亮红点
- 站点设置：站点统一 DeepSeek Key（换 Key 不重启）、默认每日限额、
  Key 模式分布统计
- **安全设置（两步验证 / TOTP）**：用手机验证器（Google / Microsoft
  Authenticator 等）扫码绑定后，登录管理台需「管理密码 + 6 位动态码」，
  附 10 枚一次性恢复码（手机不在身边时替代动态码，每枚限用一次）。
  启用 / 关闭 / 重新生成恢复码都要求再验一次动态码；每次启用或关闭会
  注销全部已登录管理会话。手机与恢复码全丢时，SSH 上机执行
  `node gateway/admin/cli.mjs totp off` 兜底恢复仅密码登录（密钥只存
  服务器 `admin-totp.json`，恢复码只存 sha256 哈希）
- **版本发布**（可选）：接入同机部署的更新分发后台后，网页上传发版、
  查看版本列表、回滚分发版本、删除历史版本——需要在服务器上再跑一个
  `raptor-update.service`（`update/update-server.mjs`，只绑 127.0.0.1:8787，
  不开公网端口），并在网关 env 里配置 `GATEWAY_UPDATE_URL` +
  `GATEWAY_UPDATE_TOKEN`（与更新后台的 `UPDATE_ADMIN_TOKEN` 一致）；
  也可继续从维护者机器 `npm run publish` 上传
- 密钥管理：更新后台的面板密钥（`crak_` 前缀，与主密钥同权、只存哈希、
  明文仅创建时展示一次），用于命令行发版与后台登录

管理会话与同学会话是两套独立 Cookie（不同名、不同签名域），互不通用；
管理登录同样有 5 次失败锁 15 分钟的防爆破（密码错误与动态码错误都计入）。

### 命令行（备用）

```bash
# 状态与日志
systemctl status raptor-gateway
journalctl -u raptor-gateway -f          # 含每个实例的运行日志（前缀 [user:ID]）
curl http://127.0.0.1:8080/health        # {"ok":true,"running":N}

# 用户管理（admin.mjs 与网关共用注册表文件）
node gateway/admin/cli.mjs list                       # 用户 + 未用邀请码 + 今日用量
node gateway/admin/cli.mjs disable 某同学             # 停用（立即禁止登录）
node gateway/admin/cli.mjs reset-pass 某同学 --password 新密码
GATEWAY_SECRET=... node gateway/admin/cli.mjs kick 某同学   # 踢下线实例
node gateway/admin/cli.mjs totp                       # 查看管理台两步验证状态
node gateway/admin/cli.mjs totp off                   # 应急关闭两步验证（需 SSH 在服务器执行）

# 升级版本
cd /opt/courseraptor && sudo -u raptor git pull && sudo -u raptor npm ci
sudo systemctl restart raptor-gateway        # 在线实例随网关重启一并回收，无感
```

环境变量完整清单见 `.env.example` 的「多用户网关」段。

## 安全须知（如实告知同学）

1. **当前为 HTTP 明文**：登录密码与教务账号在网络上未加密，请勿在公共
   WiFi 等不可信网络使用。正式化路径：域名 + ICP 备案 + Nginx 终止 TLS，
   届时把 `GATEWAY_HOST` 改为 `127.0.0.1` 即可，网关代码无需改动。
2. **站长可解密托管凭证**：实例加密密钥由服务器派生，服务器管理员技术上
   可读取同学的教务账号。班级互助场景请同学知情后自行决定是否托管。
3. **费用护栏**：统一 Key 模式下每人每日对话轮数默认 100（可调），超出后
   当天停止对话服务；自带 Key 的同学同样计数（规则透明、防脚本滥用）。
4. 自更新、QQ 桥、桌面提醒在托管实例上均禁用——这些能力归本地完整版。

## 与本地版的关系

| 能力 | 本地版（不变） | 托管版 |
| --- | --- | --- |
| 终端 TUI / 安装包 / QQ 机器人 | ✅ | 不含 |
| 网页对话 | 127.0.0.1:3210 | 经网关公网访问 |
| 数据与凭证 | 本机 `data/` + `credentials.enc` | 服务器上每人独立目录 |
| DeepSeek Key | 自己的 | 默认站点统一，可换自己的 |

两边的会话档案互不相通：托管版聊的内容不进本地版的历史，反之亦然。

## 已知边界

- 内存 1.7G 机型建议并发 ≤4；更多同学同时在线需要升配（2C4G 约可支撑 8-10）。
- 实例空闲回收后再访问有 3-5 秒冷启动（页面表现为加载稍慢，属正常）。
- 每人每日限额在网关重启后仍保留（计数落在注册表里），按自然日重置。
