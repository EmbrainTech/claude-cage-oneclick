<#
.SYNOPSIS
    检查并启用 Windows 虚拟机监控程序平台 (HypervisorPlatform / WHPX)。
.DESCRIPTION
    Claude Cage 在 Windows 10/11 家庭版与专业版均使用 WHPX 运行 Debian 13 QEMU 虚拟机，无需完整 Hyper-V 角色。
#>
[CmdletBinding()]
param(
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$feature = Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform
Write-Host "当前 HypervisorPlatform 状态: $($feature.State)" -ForegroundColor Cyan

if ($feature.State -eq 'Enabled') {
    Write-Host '[OK] WHPX 已启用，无需修改。' -ForegroundColor Green
    exit 0
}

if (-not $Apply) {
    Write-Host '如需启用，请以管理员身份运行: .\scripts\Enable-CageHypervisor.ps1 -Apply' -ForegroundColor Yellow
    exit 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '启用 Windows 可选功能需要管理员权限，请使用管理员终端执行。'
}

Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart
Write-Host '[OK] 已启用 HypervisorPlatform。请重启 Windows 使内核虚拟化生效。' -ForegroundColor Green
