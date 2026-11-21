#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeReleasePlan } from '../src/bootstrap.mjs';
import { runBackup, runDoctor, runInstall, runProxyOnboard, runSetup } from '../src/deploy.mjs';
import { inspectWindowsHost } from '../src/platform.mjs';
import { validateProxyConfig } from '../src/proxy-validator.mjs';

const HELP_TEXT = `
Claude Cage Windows 一键部署与运维 CLI

用法:
  cage-oneclick <command> [options]

命令:
  preflight       检查 Windows 版本、WHPX 虚拟化、磁盘布局与下载代理
  plan            解析官方 GitHub Release 下载计划与 SHA-256 摘要
  install         下载校验并静默安装 Claude Cage 到目标盘（默认优先 D:\\Cage）
  setup           初始化配置、启动服务、创建本机账户、绑定数据盘并应用默认设置
  deploy          全自动一键执行: preflight -> install -> setup -> doctor
  proxy-check     导入前离线预检 Clash/Mihomo YAML 或节点分享链接
  proxy-onboard   导入并验证代理节点，可选启动 Debian 13 隔离环境
  doctor          输出完整主机虚拟化、安装与 Cage 服务健康报告
  backup          安全备份 ~/.claude-cage 配置与账户元数据

通用选项:
  --version <tag>       指定 Release 标签（如 v0.1.8）
  --platform <target>   目标平台（plan 用，默认 win32-amd64）
  --install-dir <dir>   覆盖安装目录（默认自动选择 D:\\Cage）
  --data-dir <dir>      覆盖虚拟机数据目录（默认 D:\\Cage\\CageData）
  --download-dir <dir>  覆盖安装包缓存目录
  --config <path>       指定 Cage config.json 路径
  --username <name>     指定首次创建的本机 Cage 账户名
  --no-auto-account     禁用首次自动创建随机高强度账户
  --allow-unsigned      允许未签名 Windows 预览包
  --force               强制重新下载并覆盖安装
  --dry-run             仅演练流程，不执行实际安装器
  --yaml <file>         proxy-check / proxy-onboard 使用的 YAML 或分享链接文件
  --subscription <url>  proxy-onboard 使用的 HTTPS 订阅地址
  --node-id <id>        proxy-onboard 指定应用节点 ID
  --guest-system <id>   指定客机系统标识（默认按 guest.options 自动探测）
  --start-guest         proxy-onboard 成功后自动启动 Linux 隔离环境
  --output <dir>        backup 目标目录
  --json                以紧凑 JSON 输出（默认美化输出）
  -h, --help            显示帮助信息
`.trim();

/**
 * 解析命令行参数为结构化选项对象。
 */
export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'help';
  const opts = {
    command,
    version: '',
    platform: 'win32-amd64',
    installDir: '',
    dataDir: '',
    downloadDir: '',
    configPath: '',
    username: '',
    autoAccount: true,
    allowUnsigned: false,
    force: false,
    dryRun: false,
    yamlPath: '',
    subscriptionUrl: '',
    nodeId: '',
    guestSystem: '',
    startGuest: false,
    outputDir: '',
    compactJson: false,
  };

  const valueFlags = {
    '--version': 'version',
    '--platform': 'platform',
    '--install-dir': 'installDir',
    '--data-dir': 'dataDir',
    '--download-dir': 'downloadDir',
    '--config': 'configPath',
    '--username': 'username',
    '--yaml': 'yamlPath',
    '--subscription': 'subscriptionUrl',
    '--node-id': 'nodeId',
    '--guest-system': 'guestSystem',
    '--output': 'outputDir',
  };

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '-h' || flag === '--help') {
      opts.command = 'help';
      return opts;
    }
    if (flag === '--no-auto-account') { opts.autoAccount = false; continue; }
    if (flag === '--allow-unsigned') { opts.allowUnsigned = true; continue; }
    if (flag === '--force') { opts.force = true; continue; }
    if (flag === '--dry-run') { opts.dryRun = true; continue; }
    if (flag === '--start-guest') { opts.startGuest = true; continue; }
    if (flag === '--json') { opts.compactJson = true; continue; }

    const field = valueFlags[flag];
    if (!field || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(`无效参数或缺少参数值: ${flag}`);
    }
    opts[field] = args[++i];
  }
  return opts;
}

function printOutput(data, compact = false) {
  process.stdout.write(`${JSON.stringify(data, null, compact ? 0 : 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseCliArgs(argv);
    switch (opts.command) {
      case 'help':
        process.stdout.write(`${HELP_TEXT}\n`);
        return 0;
      case 'preflight':
        printOutput(await inspectWindowsHost({ explicitInstallDir: opts.installDir, explicitDataDir: opts.dataDir }), opts.compactJson);
        return 0;
      case 'plan':
        printOutput(await makeReleasePlan({ platform: opts.platform, version: opts.version, allowUnsigned: opts.allowUnsigned }), opts.compactJson);
        return 0;
      case 'install':
        printOutput(await runInstall(opts), opts.compactJson);
        return 0;
      case 'setup':
        printOutput(await runSetup(opts), opts.compactJson);
        return 0;
      case 'deploy': {
        const preflight = await inspectWindowsHost({ explicitInstallDir: opts.installDir, explicitDataDir: opts.dataDir });
        if (!preflight.ready) {
          printOutput({ status: 'preflight_blocked', preflight }, opts.compactJson);
          return 1;
        }
        const install = opts.dryRun
          ? { status: 'dry_run_skipped' }
          : await runInstall(opts);
        const setup = opts.dryRun
          ? { status: 'dry_run_skipped' }
          : await runSetup(opts);
        const doctor = opts.dryRun
          ? { status: 'dry_run_only', host: preflight }
          : await runDoctor(opts);
        printOutput({ status: opts.dryRun ? 'dry_run_ok' : 'deployed', preflight, install, setup, doctor }, opts.compactJson);
        return 0;
      }
      case 'proxy-check': {
        if (!opts.yamlPath) throw new Error('proxy-check 需要传入 --yaml <文件路径>');
        const raw = await readFile(opts.yamlPath, 'utf8');
        const result = validateProxyConfig(raw);
        printOutput(result, opts.compactJson);
        return result.valid ? 0 : 1;
      }
      case 'proxy-onboard': {
        const res = await runProxyOnboard(opts);
        printOutput(res, opts.compactJson);
        return res.status === 'onboarded' ? 0 : 1;
      }
      case 'doctor':
        printOutput(await runDoctor(opts), opts.compactJson);
        return 0;
      case 'backup':
        printOutput(await runBackup({ configPath: opts.configPath, outputDir: opts.outputDir }), opts.compactJson);
        return 0;
      default:
        throw new Error(`未知命令: ${opts.command}`);
    }
  } catch (error) {
    printOutput({ status: 'error', code: error.code || 'cli_error', message: error.message });
    return 1;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  process.exitCode = await main();
}
