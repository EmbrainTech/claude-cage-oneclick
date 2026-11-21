import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSignature } from '../src/authenticode.mjs';
import { evaluatePreflight, parseWindowsBuild, selectInstallLayout } from '../src/platform.mjs';

test('parseWindowsBuild 正确解析 Windows Build 号', () => {
  assert.equal(parseWindowsBuild('10.0.26200'), 26200);
  assert.equal(parseWindowsBuild('10.0.19045'), 19045);
  assert.equal(parseWindowsBuild('invalid'), 0);
});

test('selectInstallLayout 在存在大容量固定 D 盘时优先使用 D:\\Cage 与 D:\\Cage\\CageData', () => {
  const layout = selectInstallLayout(
    [
      { letter: 'C', freeBytes: 55 * 1024 ** 3 },
      { letter: 'D', freeBytes: 300 * 1024 ** 3 },
    ],
    { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', USERPROFILE: 'C:\\Users\\test' }
  );
  assert.equal(layout.installDir, 'D:\\Cage');
  assert.equal(layout.dataDir, 'D:\\Cage\\CageData');
  assert.equal(layout.reason, 'prefer_fixed_d_drive');
  assert.equal(layout.lowSpaceWarning, false);
});

test('selectInstallLayout 在无 D 盘时回退到 LOCALAPPDATA 与 .claude-cage\\state', () => {
  const layout = selectInstallLayout(
    [{ letter: 'C', freeBytes: 25 * 1024 ** 3 }],
    { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', USERPROFILE: 'C:\\Users\\test' }
  );
  assert.equal(layout.installDir, 'C:\\Users\\test\\AppData\\Local\\Programs\\Cage');
  assert.equal(layout.dataDir, 'C:\\Users\\test\\.claude-cage\\state');
  assert.equal(layout.lowSpaceWarning, true);
});

test('evaluatePreflight 正确阻断未启用 WHPX 或低版本 Windows', () => {
  const blocked = evaluatePreflight({
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.19044',
    buildNumber: 19044,
    hypervisorState: 'Disabled',
    layout: { dataDir: 'D:\\Cage\\CageData', dataDriveFreeGiB: 100, lowSpaceWarning: false },
  });
  assert.equal(blocked.ready, false);
  const ids = blocked.checks.filter((c) => c.status === 'blocked').map((c) => c.id);
  assert.deepEqual(ids, ['windows_build', 'whpx_feature']);
});

test('evaluateSignature 拒绝未签名或损坏签名，除非显式 allowUnsigned', () => {
  assert.equal(evaluateSignature({ Status: 'Valid', Subject: 'CN=Test' }).trusted, true);
  assert.equal(evaluateSignature({ Status: 'NotSigned' }).trusted, false);
  assert.equal(evaluateSignature({ Status: 'NotSigned' }, { allowUnsigned: true }).trusted, true);
  assert.equal(evaluateSignature({ Status: 'HashMismatch' }, { allowUnsigned: true }).trusted, false);
});
