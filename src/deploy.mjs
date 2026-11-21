import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { inspectAuthenticode } from './authenticode.mjs';
import { downloadReleaseAsset, makeReleasePlan } from './bootstrap.mjs';
import { CageClient } from './cage-client.mjs';
import { inspectWindowsHost } from './platform.mjs';
import { validateProxyConfig } from './proxy-validator.mjs';

const execFileAsync = promisify(execFile);

/**
 * 生成高强度随机本机账户密码，确保不含有歧义字符或空白符。
 */
export function generateStrongPassword(length = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * 在 Windows 上使用 icacls 收紧敏感凭据文件权限，仅保留当前登录用户与 SYSTEM 读取权限。
 */
export async function protectWindowsPrivateFile(filePath) {
  await chmod(filePath, 0o600).catch(() => {});
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || os.userInfo().username;
    await execFileAsync(
      'icacls.exe',
      [filePath, '/inheritance:r', '/grant:r', `${user}:(R,W)`],
      { timeout: 10000, windowsHide: true }
    );
  }
}

/**
 * 构建 NSIS 静默安装参数。严格遵守 `/D=` 作为最后一个参数且不带引号的规范。
 */
export function buildSilentInstallerArgs({ installDir, desktopShortcut = true, startMenuShortcut = true }) {
  const args = [
    '/S',
    `/DESKTOPSHORTCUT=${desktopShortcut ? 1 : 0}`,
    `/STARTMENUSHORTCUT=${startMenuShortcut ? 1 : 0}`,
  ];
  if (installDir) {
    args.push(`/D=${installDir}`);
  }
  return args;
}

async function ensureUpgradeProcessesStopped(installDir, existingCli) {
  if (process.platform !== 'win32' || !installDir || !existsSync(installDir)) return;
  if (existsSync(existingCli)) {
    const client = new CageClient(existingCli);
    const status = await client.call('status').catch(() => null);
    if (status?.data?.vm_running) {
      throw new Error('检测到虚拟机仍在运行，请先保存工作并执行 environment.stop 后再升级安装。');
    }
    await client.call('proxy.stop', undefined, { wait: '30s' }).catch(() => {});
  }
  // NSIS 安装器会校验 Cage.exe / cage.exe / mihomo.exe 是否占用，升级前须仅清理同目录控制与代理核心进程。
  const escapedDir = path.resolve(installDir).replace(/'/g, "''");
  const script = `
    $prefix = '${escapedDir}\\'
    Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and $_.ProcessName -in @('cage','mihomo','Cage') } |
      Stop-Process -Force -ErrorAction SilentlyContinue
  `;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 15000,
    windowsHide: true,
  }).catch(() => {});
}

async function runSilentWindowsInstaller(installerPath, installDir) {
  const args = buildSilentInstallerArgs({ installDir });
  // 通过 PowerShell Start-Process 等待 NSIS 子进程及 WebView2 安装器完整退出。
  const escapedExe = installerPath.replace(/'/g, "''");
  const argLine = args.join(' ').replace(/'/g, "''");
  const script = `
    $p = Start-Process -FilePath '${escapedExe}' -ArgumentList '${argLine}' -Wait -PassThru
    Write-Output $p.ExitCode
  `;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 300000, windowsHide: true }
  );
  const exitCode = Number(stdout.trim().split(/\r?\n/).pop());
  if (exitCode !== 0) {
    throw new Error(`Cage 安装程序退出码异常: ${exitCode}`);
  }
}

/**
 * 执行预检 + 下载校验 + 签名检查 + 静默安装。若目标版本已就位且未指定 --force，则跳过重复下载安装。
 */
export async function runInstall(options = {}, deps = {}) {
  const hostReport = await (deps.inspectHost || inspectWindowsHost)({
    explicitInstallDir: options.installDir,
    explicitDataDir: options.dataDir,
  });
  if (!hostReport.ready && !options.ignorePreflight) {
    const failed = hostReport.checks.filter((c) => c.status === 'blocked');
    throw new Error(`安装前预检未通过: ${failed.map((c) => c.detail).join('；')}`);
  }

  const targetDir = options.installDir || hostReport.layout.installDir;
  const targetCli = path.join(targetDir, 'resources', 'cage.exe');
  const existing = hostReport.existing_install;
  const plan = await (deps.makePlan || makeReleasePlan)({
    platform: 'win32-amd64',
    version: options.version || '',
    allowUnsigned: Boolean(options.allowUnsigned),
  });

  const targetVersion = plan.release.replace(/^v/, '');
  if (existing?.installLocation && existing?.displayVersion === targetVersion && existsSync(targetCli) && !options.force) {
    return {
      status: 'already_installed',
      version: existing.displayVersion,
      install_dir: existing.installLocation,
      cli_path: targetCli,
      release: plan,
    };
  }

  const downloadDir = options.downloadDir || (existsSync('D:\\') ? 'D:\\_installers\\claude-cage' : path.join(os.tmpdir(), 'claude-cage-installer'));
  const expectedAssetPath = path.join(downloadDir, plan.asset);
  let installerPath = expectedAssetPath;
  let downloaded = null;

  if (!existsSync(expectedAssetPath) || options.force) {
    downloaded = await (deps.downloadAsset || downloadReleaseAsset)(plan, downloadDir);
    installerPath = downloaded.path;
  }

  const signature = await (deps.verifySignature || inspectAuthenticode)(installerPath, {
    allowUnsigned: Boolean(options.allowUnsigned),
  });
  if (!signature.trusted) {
    throw new Error(`拒绝安装未通过数字签名验证的安装包: ${signature.reason}`);
  }

  if (!options.dryRun) {
    if (existing?.installLocation) {
      await (deps.stopUpgradeProcesses || ensureUpgradeProcessesStopped)(targetDir, targetCli);
    }
    await (deps.runInstaller || runSilentWindowsInstaller)(installerPath, targetDir);
  }

  return {
    status: options.dryRun ? 'dry_run_ready' : 'installed',
    version: targetVersion,
    install_dir: targetDir,
    cli_path: targetCli,
    installer_path: installerPath,
    signature,
    release: plan,
  };
}

/**
 * 初始化 Cage 配置、启动后台、按需创建受保护本机账户、绑定数据盘存储目录并应用推荐时区语言设置。
 */
export async function runSetup(options = {}, deps = {}) {
  const hostReport = await (deps.inspectHost || inspectWindowsHost)({
    explicitInstallDir: options.installDir,
    explicitDataDir: options.dataDir,
  });
  const installDir = hostReport.existing_install?.installLocation || options.installDir || hostReport.layout.installDir;
  const cliPath = path.join(installDir, 'resources', 'cage.exe');
  if (!existsSync(cliPath) && !options.client) {
    throw new Error(`未找到 Cage CLI: ${cliPath}，请先执行 install`);
  }

  const client = options.client || new CageClient(cliPath, { configPath: options.configPath || '' });
  const cap = await client.capabilities();
  const initRes = await client.init();
  const svcRes = await client.serviceStart();
  const acctRes = await client.call('account.status');
  const actions = [];

  let credentialsFile = '';
  if (!acctRes.data?.exists) {
    if (options.autoAccount === false) {
      return {
        status: 'account_required',
        config_path: cap.config_path,
        cli_path: cliPath,
        account: acctRes.data,
        next_step: '请在 Cage 桌面应用注册账户，或启用 --auto-account 自动生成高强度凭据。',
      };
    }
    const username = options.username || os.userInfo().username || 'cage';
    const password = options.password || generateStrongPassword(20);
    const created = await client.call('account.create', {
      username,
      password,
      confirm_password: password,
    });
    const profileDir = path.dirname(cap.config_path);
    credentialsFile = path.join(profileDir, 'LOCAL_CREDENTIALS.txt');
    const content = [
      '# Claude Cage 本机自动生成账户凭据（请妥善保管，严禁上传或提交到仓库）',
      `created_at=${new Date().toISOString()}`,
      `config_path=${cap.config_path}`,
      `username=${username}`,
      `password=${password}`,
      `recovery_key=${created.data?.recovery_key || ''}`,
      '',
    ].join('\n');
    await writeFile(credentialsFile, content, { encoding: 'utf8', mode: 0o600 });
    await (deps.protectFile || protectWindowsPrivateFile)(credentialsFile);
    actions.push({ step: 'account.create', status: 'created', username, credentials_file: credentialsFile });
  } else if (!acctRes.data?.unlocked) {
    if (!options.password) {
      return {
        status: 'account_locked',
        config_path: cap.config_path,
        cli_path: cliPath,
        account: acctRes.data,
        next_step: '账户已锁定，请在 Cage 界面解锁或使用 --password-stdin 解锁。',
      };
    }
    await client.call('account.unlock', { password: options.password });
    actions.push({ step: 'account.unlock', status: 'unlocked' });
  } else {
    actions.push({ step: 'account', status: 'already_unlocked' });
  }

  const storageRes = await client.call('storage.get');
  const desiredDataDir = options.dataDir || hostReport.layout.dataDir;
  if (desiredDataDir && storageRes.data?.directory !== desiredDataDir && !storageRes.data?.has_environment) {
    await mkdir(desiredDataDir, { recursive: true });
    await client.call('storage.set', {
      directory: desiredDataDir,
      previous: storageRes.data?.directory || '',
      migrate: false,
    });
    actions.push({ step: 'storage.set', status: 'updated', directory: desiredDataDir });
  } else {
    actions.push({ step: 'storage', status: 'kept', directory: storageRes.data?.directory || desiredDataDir });
  }

  // 先执行 dry_run 预检，再正式应用自动跟随出口时区与语言设置。
  const patchPayload = { auto_timezone: true, auto_language: true };
  await client.call('settings.patch', { patch: patchPayload, dry_run: true });
  await client.call('settings.patch', { patch: patchPayload, dry_run: false }, { wait: '2m' });
  actions.push({ step: 'settings.patch', status: 'applied', patch: patchPayload });

  const [statusRes, proxyRes, guestRes, finalStorage] = await Promise.all([
    client.call('status'),
    client.call('proxy.status'),
    client.call('guest.options'),
    client.call('storage.get'),
  ]);

  return {
    status: 'configured',
    version: cap.version,
    cli_path: cliPath,
    config_path: cap.config_path,
    initialized: initRes.data,
    service: svcRes.data,
    credentials_file: credentialsFile || null,
    actions,
    storage: finalStorage.data,
    proxy: proxyRes.data,
    guest_options: guestRes.data,
    environment_status: statusRes.data,
  };
}

/**
 * 根据 Cage `guest.options` 实际返回列表选择 Linux 客机标识（优先 debian-13，其次回退到如 ubuntu-22.04）。
 */
export function selectGuestSystem(guestOptionsData, preferred = '') {
  if (preferred) return preferred;
  const systems = Array.isArray(guestOptionsData?.linux_systems) ? guestOptionsData.linux_systems : [];
  if (systems.includes('debian-13')) return 'debian-13';
  return systems[0] || 'debian-13';
}

/**
 * 代理预检与导入编排：先静态验证 YAML，再通过 stdin 私有通道导入并应用节点。
 */
export async function runProxyOnboard({ yamlPath = '', subscriptionUrl = '', name = 'local-import', nodeId = '', guestSystem = '', startGuest = false, configPath = '', installDir = '' } = {}, deps = {}) {
  const hostReport = await (deps.inspectHost || inspectWindowsHost)({ explicitInstallDir: installDir });
  const targetDir = hostReport.existing_install?.installLocation || installDir || hostReport.layout.installDir;
  const cliPath = path.join(targetDir, 'resources', 'cage.exe');
  const client = deps.client || new CageClient(cliPath, { configPath });

  await client.serviceStart();

  let importPayload;
  let preflight = null;
  if (yamlPath) {
    const raw = await readFile(yamlPath, 'utf8');
    preflight = validateProxyConfig(raw);
    if (!preflight.valid) {
      return { status: 'validation_failed', preflight };
    }
    importPayload = { name, content: raw };
  } else if (subscriptionUrl) {
    importPayload = { name, url: subscriptionUrl, interval_hours: 0, host_download: true };
  } else {
    throw new Error('请提供 --yaml <文件路径> 或 --subscription <HTTPS订阅URL>');
  }

  await client.call('proxy.import', importPayload, { wait: '2m' });
  const proxyState = await client.call('proxy.status');
  const allNodes = (proxyState.data?.sources || []).flatMap((s) => s.nodes || []);
  const chosenId = nodeId || allNodes[0]?.id || '';
  if (!chosenId) {
    throw new Error('导入后未发现可用节点');
  }

  await client.call('proxy.select', { node_id: chosenId }, { wait: '2m' });
  const settings = await client.call('settings.get');
  const probe = await client.call('settings.probe', settings.data, { wait: '2m' });

  let guestStart = null;
  let selectedGuest = null;
  if (startGuest) {
    let guestOpts = await client.call('guest.options');
    if (guestOpts.data?.reselect && guestOpts.data?.pending?.id) {
      await client.call('guest.reselect', { id: guestOpts.data.pending.id });
      guestOpts = await client.call('guest.options');
    }
    selectedGuest = selectGuestSystem(guestOpts.data, guestSystem);
    guestStart = await client.call('environment.start', { guest_system: selectedGuest }, { wait: '30m', timeoutMs: 1850000 });
  }

  return {
    status: 'onboarded',
    preflight,
    selected_node_id: chosenId,
    selected_guest_system: selectedGuest,
    probe: probe.data,
    guest_start: guestStart?.data || null,
  };
}

/**
 * 汇总本机硬件虚拟化、安装状态、Cage doctor、账户、存储与代理状态。
 */
export async function runDoctor(options = {}, deps = {}) {
  const hostReport = await (deps.inspectHost || inspectWindowsHost)({
    explicitInstallDir: options.installDir,
    explicitDataDir: options.dataDir,
  });
  const installDir = hostReport.existing_install?.installLocation || options.installDir || hostReport.layout.installDir;
  const cliPath = path.join(installDir, 'resources', 'cage.exe');

  if (!existsSync(cliPath) && !options.client) {
    return {
      status: 'not_installed',
      host: hostReport,
      cage: null,
    };
  }

  const client = options.client || new CageClient(cliPath, { configPath: options.configPath || '' });
  await client.serviceStart().catch(() => {});
  const doctorRes = await client.doctor().catch((e) => ({ error: e.message }));
  const accountRes = await client.call('account.status').catch((e) => ({ error: e.message }));

  let unlockedDetails = null;
  if (accountRes?.data?.unlocked) {
    const [storage, proxy, status, resources] = await Promise.all([
      client.call('storage.get').catch(() => null),
      client.call('proxy.status').catch(() => null),
      client.call('status').catch(() => null),
      client.call('resources.get').catch(() => null),
    ]);
    unlockedDetails = {
      storage: storage?.data || null,
      proxy: proxy?.data || null,
      status: status?.data || null,
      resources: resources?.data || null,
    };
  }

  return {
    status: 'ok',
    host: hostReport,
    cli_path: cliPath,
    doctor: doctorRes?.data || doctorRes,
    account: accountRes?.data || accountRes,
    details: unlockedDetails,
  };
}

/**
 * 安全备份 ~/.claude-cage 中的核心配置与账户元数据（不拷贝庞大的虚拟磁盘与下载缓存）。
 */
export async function runBackup({ configPath = '', outputDir = '' } = {}) {
  const profileDir = configPath
    ? path.dirname(path.resolve(configPath))
    : path.join(os.homedir(), '.claude-cage');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = path.resolve(outputDir || path.join(profileDir, 'backups', `backup-${stamp}`));
  await mkdir(destDir, { recursive: true });

  const candidates = ['config.json', 'account.json', 'dns.json', 'appearance.json', 'favorites.json', 'proxy.json'];
  const copied = [];
  for (const name of candidates) {
    const src = path.join(profileDir, name);
    if (existsSync(src)) {
      const dst = path.join(destDir, name);
      await copyFile(src, dst);
      await protectWindowsPrivateFile(dst).catch(() => {});
      copied.push(name);
    }
  }
  return { status: 'backed_up', profile_dir: profileDir, backup_dir: destDir, files: copied };
}
