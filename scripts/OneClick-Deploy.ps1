<#
.SYNOPSIS
    Claude Cage Windows x64 全自动一键部署入口脚本。
.DESCRIPTION
    自动完成 Node.js 环境检查、下载代理探测、WHPX 预检、官方安装包 SHA-256 + Authenticode 验签安装、
    后台服务初始化、D 盘数据目录绑定与健康巡检。
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$InstallDir = "",
    [string]$DataDir = "",
    [string]$Username = "",
    [switch]$SkipAccountCreation,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$CliEntry = Join-Path $RepoRoot 'bin\cage-oneclick.mjs'

Write-Host '=== Claude Cage Windows 一键部署启动 ===' -ForegroundColor Cyan

# 1. 检查 Node.js >= 20
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw '未检测到 Node.js。请先通过 winget install OpenJS.NodeJS.LTS 安装 Node.js 20+ 后重试。'
}
$nodeVerText = (& node --version).Trim()
$nodeMajor = [int](($nodeVerText -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "当前 Node.js 版本过低 ($nodeVerText)，要求 >= v20.0.0。"
}
Write-Host "[OK] Node.js $nodeVerText" -ForegroundColor Green

# 2. 若未显式设置下载代理，自动探测常见本机代理端口仅供安装器下载使用（绝不读取第三方客户端配置）
if (-not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY) {
    foreach ($port in @(7897, 7890, 10809, 10808)) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(250, $false) -and $client.Connected) {
                $env:HTTPS_PROXY = "http://127.0.0.1:$port"
                $env:HTTP_PROXY = "http://127.0.0.1:$port"
                Write-Host "[INFO] 检测到本机下载代理端口 127.0.0.1:$port，已仅用于本次下载通道" -ForegroundColor Yellow
                $client.Close()
                break
            }
            $client.Close()
        } catch {}
    }
}

# 3. 组装参数并启用 Node 环境代理支持
$nodeArgs = @('--use-env-proxy', $CliEntry, 'deploy')
if ($Version) { $nodeArgs += @('--version', $Version) }
if ($InstallDir) { $nodeArgs += @('--install-dir', $InstallDir) }
if ($DataDir) { $nodeArgs += @('--data-dir', $DataDir) }
if ($Username) { $nodeArgs += @('--username', $Username) }
if ($SkipAccountCreation) { $nodeArgs += '--no-auto-account' }
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($Force) { $nodeArgs += '--force' }

& node @nodeArgs
if ($LASTEXITCODE -ne 0) {
    throw "一键部署返回错误码 $LASTEXITCODE"
}

Write-Host '=== 部署与巡检执行完成 ===' -ForegroundColor Green
