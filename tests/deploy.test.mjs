import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseCliArgs } from '../bin/cage-oneclick.mjs';
import { CageClient } from '../src/cage-client.mjs';
import { buildSilentInstallerArgs, runInstall, runSetup, selectGuestSystem } from '../src/deploy.mjs';

test('selectGuestSystem 优先使用 debian-13 否则自动回退到服务端实际支持的 Linux 客机', () => {
  assert.equal(selectGuestSystem({ linux_systems: ['ubuntu-22.04', 'debian-13'] }), 'debian-13');
  assert.equal(selectGuestSystem({ linux_systems: ['ubuntu-22.04'] }), 'ubuntu-22.04');
  assert.equal(selectGuestSystem({ linux_systems: ['ubuntu-22.04'] }, 'custom-guest'), 'custom-guest');
});

test('buildSilentInstallerArgs 保证 /D= 位于最后一个参数且不带引号', () => {
  const args = buildSilentInstallerArgs({ installDir: 'D:\\My Cage', desktopShortcut: true, startMenuShortcut: false });
  assert.deepEqual(args, ['/S', '/DESKTOPSHORTCUT=1', '/STARTMENUSHORTCUT=0', '/D=D:\\My Cage']);
});

test('runInstall 在签名未通过时中止安装', async () => {
  await assert.rejects(
    () =>
      runInstall(
        { version: 'v0.1.8' },
        {
          inspectHost: async () => ({
            ready: true,
            checks: [],
            layout: { installDir: 'D:\\Cage', dataDir: 'D:\\Cage\\CageData' },
            existing_install: null,
          }),
          makePlan: async () => ({
            release: 'v0.1.8',
            asset: 'Cage-0.1.8-windows-amd64-setup.exe',
            size: 100,
            sha256: 'c'.repeat(64),
          }),
          downloadAsset: async (plan) => ({ ...plan, path: 'D:\\_installers\\claude-cage\\Cage-0.1.8-windows-amd64-setup.exe' }),
          verifySignature: async () => ({ trusted: false, status: 'HashMismatch', reason: '摘要不匹配' }),
        }
      ),
    /数字签名/
  );
});

test('runSetup 自动完成账户创建、凭据落盘、存储绑定与设置应用', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cage-setup-test-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  const calls = [];
  const mockClient = new CageClient('cage.exe', {
    runner: async (_exe, args, opts) => {
      const cmd = args[1];
      const op = args[2] || '';
      const body = opts.stdinText ? JSON.parse(opts.stdinText) : null;
      calls.push({ cmd, op, body });
      const reply = (data) => ({ stdout: JSON.stringify({ protocol: 1, version: '0.1.8', config_path: cfgPath, status: 'completed', data }), stderr: '', exitCode: 0 });
      if (cmd === 'capabilities') return reply({ operations: [] });
      if (cmd === 'init') return reply({ created: true });
      if (cmd === 'service.start') return reply({ service_ready: true });
      if (op === 'account.status') return reply({ exists: false, unlocked: false });
      if (op === 'account.create') return reply({ recovery_key: 'RK-MOCK-TEST-001' });
      if (op === 'storage.get') return reply({ directory: path.join(tmpDir, 'state'), has_environment: false });
      if (op === 'storage.set') return reply({ directory: body.directory });
      if (op === 'settings.patch') return reply({ applied: !body.dry_run });
      return reply({});
    },
  });

  try {
    const res = await runSetup(
      { client: mockClient, dataDir: path.join(tmpDir, 'CageData'), username: 'tester' },
      {
        inspectHost: async () => ({
          layout: { installDir: tmpDir, dataDir: path.join(tmpDir, 'CageData') },
          existing_install: { installLocation: tmpDir },
        }),
        protectFile: async () => {},
      }
    );

    assert.equal(res.status, 'configured');
    assert.ok(res.credentials_file);
    const credText = await readFile(res.credentials_file, 'utf8');
    assert.match(credText, /username=tester/);
    assert.match(credText, /recovery_key=RK-MOCK-TEST-001/);
    assert.ok(calls.some((c) => c.op === 'settings.patch' && c.body.dry_run === true));
    assert.ok(calls.some((c) => c.op === 'settings.patch' && c.body.dry_run === false));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('runInstall 覆盖升级已有安装前调用 stopUpgradeProcesses 清理占用', async () => {
  let stopped = false;
  let installed = false;
  const res = await runInstall(
    { version: 'v0.2.0-rc' },
    {
      inspectHost: async () => ({
        ready: true,
        checks: [],
        layout: { installDir: 'D:\\Cage', dataDir: 'D:\\Cage\\CageData' },
        existing_install: { installLocation: 'D:\\Cage', displayVersion: '0.1.8' },
      }),
      makePlan: async () => ({
        release: 'v0.2.0-rc',
        asset: 'Cage-0.2.0-rc-windows-amd64-setup.exe',
        size: 100,
        sha256: 'd'.repeat(64),
      }),
      downloadAsset: async (plan) => ({ ...plan, path: 'D:\\_installers\\claude-cage\\Cage-0.2.0-rc-windows-amd64-setup.exe' }),
      verifySignature: async () => ({ trusted: true, status: 'Valid', reason: 'ok' }),
      stopUpgradeProcesses: async () => { stopped = true; },
      runInstaller: async () => {
        assert.equal(stopped, true);
        installed = true;
      },
    }
  );
  assert.equal(installed, true);
  assert.equal(res.status, 'installed');
});

test('parseCliArgs 正确解析命令行参数与标志', () => {
  const parsed = parseCliArgs(['deploy', '--version', 'v0.1.8', '--install-dir', 'D:\\Cage', '--dry-run', '--json']);
  assert.equal(parsed.command, 'deploy');
  assert.equal(parsed.version, 'v0.1.8');
  assert.equal(parsed.installDir, 'D:\\Cage');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.compactJson, true);
});
