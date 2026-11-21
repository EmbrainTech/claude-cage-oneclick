import { spawn } from 'node:child_process';

/**
 * 解析 cage agent 命令单行 JSON 输出与退出码含义。
 */
export function parseAgentEnvelope(stdoutText, exitCode = 0) {
  const line = String(stdoutText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) {
    throw new Error(`cage agent 未返回 JSON 输出 (exitCode=${exitCode})`);
  }
  const envelope = JSON.parse(line);
  return { ...envelope, exit_code: exitCode };
}

/**
 * 根据 cage agent 退出码及 envelope 构造可读错误对象。
 */
export class CageAgentError extends Error {
  constructor(envelope) {
    const err = envelope?.error || {};
    super(err.message || `Cage 操作失败 (${err.code || 'unknown'})`);
    this.code = err.code || 'operation_failed';
    this.next_action = err.next_action || '';
    this.retryable = Boolean(err.retryable);
    this.http_status = err.http_status || 0;
    this.exit_code = envelope?.exit_code ?? 1;
  }
}

/**
 * 封装 `cage.exe agent` CLI：所有含凭据或配置的 JSON 一律通过 stdin (`--input -`) 传递，绝不进入命令行参数。
 */
export class CageClient {
  constructor(cliPath, { configPath = '', scope = 'local', connection = '', runner = null } = {}) {
    this.cliPath = cliPath;
    this.configPath = configPath;
    this.scope = scope;
    this.connection = connection;
    this.runner = runner || defaultSubprocessRunner;
  }

  buildArgs(command, operand = '', { inputStdin = false, outputPath = '', wait = '', scopeOverride = '' } = {}) {
    const args = ['agent', command];
    if (operand) args.push(operand);
    if (this.configPath) args.push('--config', this.configPath);
    const activeScope = scopeOverride || this.scope;
    if (activeScope && activeScope !== 'local' && ['call', 'request', 'socket', 'job', 'routes', 'doctor', 'diagnostics'].includes(command)) {
      args.push('--scope', activeScope);
    }
    if (this.connection) args.push('--connection', this.connection);
    if (inputStdin) args.push('--input', '-');
    if (outputPath) args.push('--output', outputPath);
    if (wait) args.push('--wait', wait);
    return args;
  }

  async exec(command, { operand = '', payload = undefined, outputPath = '', wait = '', scopeOverride = '', timeoutMs = 120000 } = {}) {
    const hasPayload = payload !== undefined;
    const args = this.buildArgs(command, operand, { inputStdin: hasPayload, outputPath, wait, scopeOverride });
    const stdinText = hasPayload ? JSON.stringify(payload) : '';
    const { stdout, stderr, exitCode } = await this.runner(this.cliPath, args, { stdinText, timeoutMs });
    let envelope;
    try {
      envelope = parseAgentEnvelope(stdout, exitCode);
    } catch (error) {
      throw new Error(`${error.message}${stderr ? `; stderr=${stderr.trim()}` : ''}`);
    }
    if (envelope.status === 'error') {
      throw new CageAgentError(envelope);
    }
    return envelope;
  }

  capabilities() {
    return this.exec('capabilities');
  }

  doctor(scopeOverride = '') {
    return this.exec('doctor', { scopeOverride });
  }

  init() {
    return this.exec('init');
  }

  serviceStart() {
    return this.exec('service.start');
  }

  hostInspect() {
    return this.exec('host.inspect');
  }

  routes(scopeOverride = '') {
    return this.exec('routes', { scopeOverride });
  }

  call(name, payload = undefined, { wait = '', scopeOverride = '', timeoutMs = 180000 } = {}) {
    return this.exec('call', { operand: name, payload, wait, scopeOverride, timeoutMs });
  }

  job(id, { wait = '', scopeOverride = '', timeoutMs = 180000 } = {}) {
    return this.exec('job', { operand: id, wait, scopeOverride, timeoutMs });
  }

  diagnostics(outputPath) {
    return this.exec('diagnostics', { outputPath });
  }
}

export function defaultSubprocessRunner(executable, args, { stdinText = '', timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`执行 ${executable} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on('data', (d) => stdoutChunks.push(d));
    child.stderr.on('data', (d) => stderrChunks.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: exitCode ?? 1,
      });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}
