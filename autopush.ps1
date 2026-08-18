$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host "       LIENG ONLINE - TU DONG DAY CODE LEN GIT          " -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Yellow
Write-Host ""
node "$ScriptDir/scripts/autopush.js" @args
Write-Host ""
Write-Host "Xong. Nhan Enter de tiep tuc..." -ForegroundColor Gray
Read-Host
