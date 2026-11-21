<#
.SYNOPSIS
    定位并启动已安装的 Claude Cage 桌面工作台。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ClaudeCage'
$installDir = $null

if (Test-Path $regPath) {
    $installDir = (Get-ItemProperty $regPath -ErrorAction SilentlyContinue).InstallLocation
}
if (-not $installDir -and (Test-Path 'D:\Cage\Cage.exe')) {
    $installDir = 'D:\Cage'
}
if (-not $installDir) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Cage'
    if (Test-Path (Join-Path $candidate 'Cage.exe')) {
        $installDir = $candidate
    }
}

if (-not $installDir) {
    throw '未找到已安装的 Claude Cage，请先运行 .\scripts\OneClick-Deploy.ps1。'
}

$launcher = Join-Path $installDir 'Cage.exe'
if (-not (Test-Path $launcher)) {
    throw "未找到启动器: $launcher"
}

Start-Process -FilePath $launcher
Write-Host "[OK] 已启动 Claude Cage 工作台: $launcher" -ForegroundColor Green
