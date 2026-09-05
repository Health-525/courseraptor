@echo off
rem CourseRaptor 一键启动（同学侧）：首次运行自动装依赖，之后直接进对话
chcp 65001 >nul
cd /d "%~dp0"
echo 🦖 CourseRaptor 启动中...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] 未检测到 Node.js，请先安装 24 或更高版本：https://nodejs.org/zh-cn
  echo     安装完成后重新双击本文件即可。
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo [!] Node.js 版本过低，本项目需要 Node.js 24 或更高版本。
  echo     请升级后重新双击本文件。
  pause
  exit /b 1
)

if not exist "node_modules/.package-lock.json" (
  echo [i] 首次运行，安装依赖中，可能需要几分钟，请耐心等待...
  call npm ci
  if errorlevel 1 (
    echo.
    echo [!] 依赖安装失败，检查网络后重试。反馈时请遮盖个人信息。
    pause
    exit /b 1
  )
)

node "bin/raptor.cjs"
if errorlevel 1 pause
