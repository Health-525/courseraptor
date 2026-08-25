# CourseRaptor QQ 桥常驻服务安装脚本
# 作用：注册 Windows 计划任务（登录自启 + 崩溃自动重启 + 日志落盘）
# 用法：powershell -ExecutionPolicy Bypass -File install-qq-task.ps1
# 管理：
#   启动  schtasks /run /tn CourseRaptorQQ
#   停止  schtasks /end /tn CourseRaptorQQ
#   日志  Get-Content D:\A\courseraptor\qq-bridge.log -Tail 30 -Wait
#   卸载  Unregister-ScheduledTask -TaskName CourseRaptorQQ -Confirm:$false

$taskName = "CourseRaptorQQ"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$cmd = "/c cd /d `"$projectDir`" && npm run qq >> `"$projectDir\qq-bridge.log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "已注册计划任务 $taskName（登录自启 / 崩溃自动重启 / 禁止重复实例）"

Start-ScheduledTask -TaskName $taskName
Write-Host "已启动，日志：$projectDir\qq-bridge.log（注意定期清理该文件）"
