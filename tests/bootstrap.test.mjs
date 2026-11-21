import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BootstrapError,
  checksumFor,
  downloadReleaseAsset,
  makeReleasePlan,
  selectStaticAsset,
} from '../src/bootstrap.mjs';

test('checksumFor 精确校验唯一 SHA-256 条目', () => {
  const hash = 'a'.repeat(64);
  const manifest = `${hash}  Cage-0.1.8-windows-amd64-setup.exe\n`;
  assert.equal(checksumFor(manifest, 'Cage-0.1.8-windows-amd64-setup.exe'), hash);
  assert.throws(() => checksumFor(manifest + manifest, 'Cage-0.1.8-windows-amd64-setup.exe'), BootstrapError);
  assert.throws(() => checksumFor(manifest, 'missing.exe'), BootstrapError);
});

test('selectStaticAsset 拒绝未经允许的未签名 Windows 预览包', () => {
  const hash = 'b'.repeat(64);
  const manifest = `${hash}  Cage-0.1.9-rc.1-windows-amd64-setup-unsigned.exe\n`;
  assert.throws(
    () => selectStaticAsset('v0.1.9-rc.1', manifest, { platform: 'win32-amd64', allowUnsigned: false }),
    (err) => err.code === 'unsigned_package_requires_consent'
  );
  const allowed = selectStaticAsset('v0.1.9-rc.1', manifest, { platform: 'win32-amd64', allowUnsigned: true });
  assert.equal(allowed.unsigned, true);
  assert.equal(allowed.sha256, hash);
});

test('makeReleasePlan 在 API 限流时自动回退到 /releases/latest 重定向解析', async () => {
  const payload = Buffer.from('mock-installer-binary');
  const sha = createHash('sha256').update(payload).digest('hex');
  const manifest = `${sha}  Cage-0.1.8-windows-amd64-setup.exe\n`;

  const mockFetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('api.github.com')) {
      return new Response('rate limit', { status: 403 });
    }
    if (href.endsWith('/releases/latest') && init.method === 'HEAD') {
      return new Response(null, { status: 302, headers: { location: 'https://github.com/Lee-xeo/Claude-Cage/releases/tag/v0.1.8' } });
    }
    if (href.endsWith('/SHA256SUMS')) {
      return new Response(manifest, { status: 200 });
    }
    if (href.endsWith('Cage-0.1.8-windows-amd64-setup.exe') && init.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(payload.length) } });
    }
    return new Response('not found', { status: 404 });
  };

  const plan = await makeReleasePlan({ platform: 'win32-amd64' }, mockFetch);
  assert.equal(plan.release, 'v0.1.8');
  assert.equal(plan.size, payload.length);
  assert.equal(plan.sha256, sha);
});

test('downloadReleaseAsset 成功校验写入并拦截损坏或超长响应', async () => {
  const payload = Buffer.from('verified-cage-setup-bytes');
  const sha = createHash('sha256').update(payload).digest('hex');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cage-dl-test-'));
  try {
    const plan = {
      release: 'v0.1.8',
      asset: 'Cage-0.1.8-windows-amd64-setup.exe',
      url: 'https://github.com/Lee-xeo/Claude-Cage/releases/download/v0.1.8/Cage-0.1.8-windows-amd64-setup.exe',
      size: payload.length,
      sha256: sha,
    };

    const okFetch = async () => new Response(payload, { status: 200 });
    const res = await downloadReleaseAsset(plan, dir, okFetch);
    assert.deepEqual(await readFile(res.path), payload);

    const badFetch = async () => new Response(Buffer.from('corrupted-cage-setup-byte'), { status: 200 });
    await assert.rejects(
      () => downloadReleaseAsset({ ...plan, asset: 'bad.exe' }, dir, badFetch),
      (err) => err.code === 'checksum_mismatch'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
