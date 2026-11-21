import assert from 'node:assert/strict';
import test from 'node:test';

import { CageAgentError, CageClient, parseAgentEnvelope } from '../src/cage-client.mjs';

test('parseAgentEnvelope 正确读取多行 stdout 中最后一行协议 JSON', () => {
  const env = parseAgentEnvelope('debug line\n{"protocol":1,"version":"0.1.8","status":"completed","data":{"ok":true}}\n', 0);
  assert.equal(env.protocol, 1);
  assert.equal(env.data.ok, true);
  assert.equal(env.exit_code, 0);
});

test('CageClient 通过 stdin 传递敏感输入而不将其暴露在命令行参数中', async () => {
  const captured = [];
  const client = new CageClient('D:\\Cage\\resources\\cage.exe', {
    runner: async (exe, args, opts) => {
      captured.push({ exe, args, opts });
      return {
        stdout: JSON.stringify({ protocol: 1, version: '0.1.8', status: 'completed', data: { recovery_key: 'rk-123' } }),
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const secret = 'VerySecretPassword123!';
  const res = await client.call('account.create', { username: 'u1', password: secret, confirm_password: secret });
  assert.equal(res.data.recovery_key, 'rk-123');
  assert.equal(captured[0].args.includes('--input'), true);
  assert.equal(captured[0].args.includes('-'), true);
  assert.equal(captured[0].args.join(' ').includes(secret), false);
  assert.equal(JSON.parse(captured[0].opts.stdinText).password, secret);
});

test('CageClient 遇到错误响应时抛出带错误码与 next_action 的 CageAgentError', async () => {
  const client = new CageClient('cage.exe', {
    runner: async () => ({
      stdout: JSON.stringify({
        protocol: 1,
        version: '0.1.8',
        status: 'error',
        error: { code: 'account_locked', message: 'Locked', next_action: 'account.unlock', http_status: 423 },
      }),
      stderr: '',
      exitCode: 3,
    }),
  });

  await assert.rejects(
    () => client.call('status'),
    (err) => err instanceof CageAgentError && err.code === 'account_locked' && err.exit_code === 3
  );
});
