import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const MIN_WINDOWS_BUILD = 19045;
const RECOMMENDED_DATA_GIB = 28;
const UNINSTALL_REG_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ClaudeCage';

/**
 * 解析 Windows 内核版本号中的 Build 号。
 * 例如 "10.0.26200" -> 26200。
 */
export function parseWindowsBuild(releaseStr) {
  const match = String(releaseStr ?? '').trim().match(/^\d+\.\d+\.(\d+)/);
  return match ? Number(match[1]) : 0;
}

/**
 * 根据固定磁盘空间与环境变量推荐 Cage 安装目录与虚拟机数据目录。
 * 当本地存在固定盘 D: 且可用空间充足（>= 20 GiB）时，优先落在 D:\Cage 与 D:\Cage\CageData，避免挤占 C 盘。
 */
export function selectInstallLayout(drives = [], env = process.env, explicitInstallDir = '', explicitDataDir = '') {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const userProfile = env.USERPROFILE || os.homedir();
  const normalizedDrives = drives
    .map((d) => ({
      letter: String(d.letter || '').replace(/[:\\/]+$/g, '').toUpperCase(),
      freeBytes: Number(d.freeBytes || 0),
    }))
    .filter((d) => d.letter.length === 1 && Number.isFinite(d.freeBytes));

  const dDrive = normalizedDrives.find((d) => d.letter === 'D');
  const cDrive = normalizedDrives.find((d) => d.letter === 'C');

  let installDir = explicitInstallDir ? path.resolve(explicitInstallDir) : '';
  let reason = 'user_specified';

  if (!installDir) {
    if (dDrive && dDrive.freeBytes >= 20 * GIB) {
      installDir = 'D:\\Cage';
      reason = 'prefer_fixed_d_drive';
    } else {
      installDir = path.join(localAppData, 'Programs', 'Cage');
      reason = 'default_localappdata';
    }
  }

  let dataDir = explicitDataDir ? path.resolve(explicitDataDir) : '';
  if (!dataDir) {
    // 遵循 Cage Windows 安装约定：若安装目录在独立数据盘或显式目录，默认使用 <installDir>\CageData。
    if (installDir.toUpperCase().startsWith('D:\\')) {
      dataDir = path.join(installDir, 'CageData');
    } else if (dDrive && dDrive.freeBytes >= RECOMMENDED_DATA_GIB * GIB) {
      dataDir = 'D:\\CageData';
    } else {
      dataDir = path.join(userProfile, '.claude-cage', 'state');
    }
  }

  const targetLetter = installDir.slice(0, 1).toUpperCase();
  const dataLetter = dataDir.slice(0, 1).toUpperCase();
  const targetDrive = normalizedDrives.find((d) => d.letter === targetLetter) || cDrive;
  const dataDrive = normalizedDrives.find((d) => d.letter === dataLetter) || targetDrive;

  return {
    installDir,
    dataDir,
    profileDir: path.join(userProfile, '.claude-cage'),
    cliPath: path.join(installDir, 'resources', 'cage.exe'),
    launcherPath: path.join(installDir, 'Cage.exe'),
    reason,
    installDriveFreeGiB: targetDrive ? Number((targetDrive.freeBytes / GIB).toFixed(2)) : null,
    dataDriveFreeGiB: dataDrive ? Number((dataDrive.freeBytes / GIB).toFixed(2)) : null,
    lowSpaceWarning: dataDrive ? dataDrive.freeBytes < RECOMMENDED_DATA_GIB * GIB : false,
  };
}

/**
 * 纯函数预检评估：整合系统平台、Windows Build、WHPX 状态、磁盘空间与代理可达性。
 */
export function evaluatePreflight(facts) {
  const checks = [];
  const add = (id, status, detail, nextAction = '') => checks.push({ id, status, detail, next_action: nextAction });

  const isWinX64 = facts.platform === 'win32' && facts.arch === 'x64';
  add(
    'os_platform',
    isWinX64 ? 'ok' : 'blocked',
    isWinX64 ? `Windows x64 (${facts.osRelease})` : `不支持的平台 ${facts.platform}/${facts.arch}，本部署工具面向 Windows x64`,
    isWinX64 ? '' : 'use_windows_x64'
  );

  const buildOk = !isWinX64 || facts.buildNumber >= MIN_WINDOWS_BUILD;
  add(
    'windows_build',
    buildOk ? 'ok' : 'blocked',
    `Windows Build ${facts.buildNumber}（要求 >= ${MIN_WINDOWS_BUILD}）`,
    buildOk ? '' : 'upgrade_windows'
  );

  const whpxState = String(facts.hypervisorState || 'unknown');
  if (whpxState === 'Enabled') {
    add('whpx_feature', 'ok', 'Windows 虚拟机监控程序平台（HypervisorPlatform）已启用');
  } else if (whpxState === 'Disabled') {
    add(
      'whpx_feature',
      'blocked',
      'HypervisorPlatform 未启用，Debian 13 虚拟机无法使用 WHPX 硬件加速',
      'enable_hypervisor_platform'
    );
  } else {
    add(
      'whpx_feature',
      'warn',
      `未能确认 HypervisorPlatform 状态（${whpxState}），安装后将由 QEMU 实测确认`,
      'verify_whpx'
    );
  }

  if (facts.existingInstall?.installLocation) {
    const hasWhpx = Array.isArray(facts.qemuAccels) && facts.qemuAccels.includes('whpx');
    add(
      'qemu_whpx',
      hasWhpx ? 'ok' : 'warn',
      hasWhpx ? '随附 QEMU 支持 whpx + tcg 加速' : `QEMU 加速检测异常: ${(facts.qemuAccels || []).join(', ') || '未检测到'}`,
      hasWhpx ? '' : 'check_bios_virtualization'
    );
  }

  const freeGiB = facts.layout?.dataDriveFreeGiB;
  const spaceOk = freeGiB === null || freeGiB >= 20;
  add(
    'disk_space',
    spaceOk ? (facts.layout?.lowSpaceWarning ? 'warn' : 'ok') : 'blocked',
    freeGiB !== null
      ? `数据目录 ${facts.layout.dataDir} 所在磁盘可用 ${freeGiB} GiB`
      : `数据目录 ${facts.layout?.dataDir || '未知'}`,
    spaceOk ? '' : 'free_disk_space'
  );

  const proxySummary = facts.proxyInfo?.activeProxyUrl
    ? `检测到可用主机下载代理 ${facts.proxyInfo.activeProxyUrl}`
    : '未检测到本地环境变量或常见代理端口，将使用直连下载安装包';
  add('host_download_network', 'ok', proxySummary);

  const blocked = checks.some((c) => c.status === 'blocked');
  return {
    ready: !blocked,
    checks,
    layout: facts.layout,
    existing_install: facts.existingInstall || null,
    proxy: facts.proxyInfo || null,
  };
}

/**
 * 探测 TCP 本地端口是否处于监听状态（仅检测连通性，不读取任何外部代理凭据）。
 */
export function probeTcpPort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 探测主机下载代理（环境变量或本地常见端口），严格不读取第三方客户端私有配置或订阅文件。
 */
export async function detectDownloadProxy(env = process.env) {
  const envProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '';
  if (envProxy) {
    return { source: 'env', activeProxyUrl: envProxy, detectedPorts: [] };
  }
  const commonPorts = [7897, 7890, 10809, 10808, 2080];
  const openPorts = [];
  for (const port of commonPorts) {
    if (await probeTcpPort('127.0.0.1', port)) {
      openPorts.push(port);
    }
  }
  return {
    source: openPorts.length > 0 ? 'local_port_probe' : 'direct',
    activeProxyUrl: openPorts.length > 0 ? `http://127.0.0.1:${openPorts[0]}` : '',
    detectedPorts: openPorts,
  };
}

async function runPowerShellJson(script) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15000, windowsHide: true }
  );
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

/**
 * 查询本机固定硬盘可用空间、HypervisorPlatform 状态、注册表已有安装及 QEMU 加速能力。
 */
export async function inspectWindowsHost({ explicitInstallDir = '', explicitDataDir = '' } = {}) {
  const platform = process.platform;
  const arch = process.arch;
  const osRelease = os.release();
  const buildNumber = parseWindowsBuild(osRelease);

  let drives = [];
  let hypervisorState = 'unknown';
  let existingInstall = null;

  if (platform === 'win32') {
    try {
      const info = await runPowerShellJson(`
        $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
          @{ letter = ($_.DeviceID -replace ':',''); freeBytes = [double]$_.FreeSpace }
        })
        $hv = 'unknown'
        try {
          $feat = Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -ErrorAction Stop
          $hv = [string]$feat.State
        } catch {}
        $reg = $null
        if (Test-Path '${UNINSTALL_REG_KEY}') {
          $p = Get-ItemProperty '${UNINSTALL_REG_KEY}' -ErrorAction SilentlyContinue
          if ($p) {
            $reg = @{
              installLocation = [string]$p.InstallLocation
              displayVersion = [string]$p.DisplayVersion
              quietUninstallString = [string]$p.QuietUninstallString
            }
          }
        }
        @{ disks = $disks; hypervisorState = $hv; existingInstall = $reg } | ConvertTo-Json -Depth 4 -Compress
      `);
      if (info) {
        drives = info.disks || [];
        hypervisorState = info.hypervisorState || 'unknown';
        existingInstall = info.existingInstall || null;
      }
    } catch {
      // 回退到基础环境变量布局，保证非特权受限环境仍可计算路径。
    }
  }

  const layout = selectInstallLayout(drives, process.env, explicitInstallDir, explicitDataDir);
  if (!existingInstall && existsSync(layout.cliPath)) {
    existingInstall = { installLocation: layout.installDir, displayVersion: '', quietUninstallString: '' };
  }

  let qemuAccels = [];
  const installRoot = existingInstall?.installLocation || layout.installDir;
  const qemuExe = path.join(installRoot, 'resources', 'runtime', 'qemu', 'qemu-system-x86_64.exe');
  if (platform === 'win32' && existsSync(qemuExe)) {
    try {
      const { stdout } = await execFileAsync(qemuExe, ['-accel', 'help'], { timeout: 5000, windowsHide: true });
      qemuAccels = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('Accelerators'));
    } catch {
      qemuAccels = [];
    }
  }

  const proxyInfo = await detectDownloadProxy(process.env);
  return evaluatePreflight({
    platform,
    arch,
    osRelease,
    buildNumber,
    hypervisorState,
    qemuAccels,
    layout,
    existingInstall,
    proxyInfo,
  });
}
