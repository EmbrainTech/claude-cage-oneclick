import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPSTREAM_REPO = 'Lee-xeo/Claude-Cage';
export const PROTOCOL_VERSION = 1;

const SUFFIXES = {
  'darwin-arm64': 'macos-arm64.dmg',
  'linux-amd64': 'linux-amd64.deb',
  'win32-amd64': 'windows-amd64-setup.exe',
};

export class BootstrapError extends Error {
  constructor(code, message, nextAction = 'plan') {
    super(message);
    this.code = code;
    this.next_action = nextAction;
  }
}

const fail = (code, message, next = 'plan') => {
  throw new BootstrapError(code, message, next);
};

export const releaseDownloadUrl = (tag, name) =>
  `https://github.com/${UPSTREAM_REPO}/releases/download/${tag}/${name}`;

/**
 * 校验并追踪公开 HTTPS 请求，禁止 HTTP 降级和 URL 内嵌凭据，防止被劫持或泄露信息。
 */
export async function fetchHttpsStrict(url, fetchImpl = fetch, method = 'GET') {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      fail('unsafe_download', '仅允许无内嵌凭据的公开 HTTPS 下载地址。');
    }
    let response;
    try {
      response = await fetchImpl(parsed, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(120000),
        headers: {
          'User-Agent': 'Claude-Cage-OneClick/1.0',
          Accept: 'application/json, application/octet-stream',
        },
      });
    } catch {
      fail(
        'download_connection_failed',
        '无法连接到 GitHub Release 下载源。请检查本机网络或代理设置（Node 24 可配合 --use-env-proxy）。',
        'check_host_network'
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail('download_failed', '下载重定向缺少 Location 头。');
      current = new URL(location, parsed).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const code = response.status === 403 || response.status === 429 ? 'rate_limited' : 'download_failed';
      fail(code, `公开下载接口返回 HTTP ${response.status}，请稍后重试或指定 --version。`);
    }
    return response;
  }
  fail('download_failed', '下载重定向次数过多。');
}

async function readBoundedText(url, fetchImpl) {
  const response = await fetchHttpsStrict(url, fetchImpl);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 4 * 1024 * 1024) fail('invalid_release', 'Release 元数据体积超出限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * 从 SHA256SUMS 文本中精准提取唯一匹配的包摘要；缺失或重复均直接报错。
 */
export function checksumFor(manifest, assetName) {
  const matches = manifest
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-fA-F0-9]{64}) [ *](\S+)\s*$/))
    .filter((m) => m && m[2] === assetName);
  if (matches.length !== 1) {
    fail('invalid_checksum_manifest', `SHA256SUMS 中未找到唯一匹配的条目: ${assetName}`);
  }
  return matches[0][1].toLowerCase();
}

/**
 * 校验 Release 标签与静态附件清单，防止签名包被静默降级为未签名包。
 */
export function selectStaticAsset(tag, manifest, { platform, allowUnsigned = false }) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag)) {
    fail('invalid_release', `非法的 Release 标签: ${tag}`);
  }
  if (!SUFFIXES[platform]) {
    fail('unsupported_platform', `不支持的平台: ${platform}`);
  }
  const version = tag.slice(1);
  const listed = new Set(
    manifest
      .split(/\r?\n/)
      .map((line) => line.match(/^[a-fA-F0-9]{64} [ *](\S+)\s*$/)?.[1])
      .filter(Boolean)
  );
  let name = `Cage-${version}-${SUFFIXES[platform]}`;
  let unsigned = false;
  if (!listed.has(name) && platform === 'win32-amd64') {
    const unsignedName = `Cage-${version}-windows-amd64-setup-unsigned.exe`;
    if (listed.has(unsignedName)) {
      if (!allowUnsigned) {
        fail(
          'unsigned_package_requires_consent',
          '该版本仅提供未签名 Windows 预览包，必须显式传入 --allow-unsigned 才能继续。',
          'user_decision'
        );
      }
      name = unsignedName;
      unsigned = true;
    }
  }
  if (!listed.has(name)) {
    fail('asset_unavailable', `Release ${tag} 缺少对应平台的安装包或 SHA256SUMS 条目: ${name}`);
  }
  return { name, unsigned, sha256: checksumFor(manifest, name) };
}

/**
 * 通过 GitHub Releases 跳转页解析最新正式版本号（不消耗 REST API 配额）。
 */
export async function resolveLatestTag(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(new URL(`https://github.com/${UPSTREAM_REPO}/releases/latest`), {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'Claude-Cage-OneClick/1.0' },
    });
    await res.body?.cancel();
    const location = [301, 302, 303, 307, 308].includes(res.status) ? res.headers.get('location') : null;
    const match = location?.match(/\/releases\/tag\/(v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * 构建下载计划：解析目标版本、静态下载 URL、权威字节大小与预期 SHA-256。
 */
export async function makeReleasePlan(
  { platform = 'win32-amd64', version = '', allowUnsigned = false } = {},
  fetchImpl = fetch
) {
  let tag = version ? (version.startsWith('v') ? version : `v${version}`) : '';
  if (!tag) {
    try {
      const release = JSON.parse(
        await readBoundedText(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`, fetchImpl)
      );
      tag = release.tag_name || '';
    } catch (error) {
      if (!(error instanceof BootstrapError) || error.code !== 'rate_limited') throw error;
    }
    if (!tag) tag = await resolveLatestTag(fetchImpl);
    if (!tag) {
      fail('rate_limited', '无法获取最新 Release 版本号，请通过 --version 显式指定标签。', 'choose_version');
    }
  }

  const manifest = await readBoundedText(releaseDownloadUrl(tag, 'SHA256SUMS'), fetchImpl);
  const selected = selectStaticAsset(tag, manifest, { platform, allowUnsigned });
  const url = releaseDownloadUrl(tag, selected.name);
  const head = await fetchHttpsStrict(url, fetchImpl, 'HEAD');
  await head.body?.cancel();
  const size = Number(head.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size <= 0) {
    fail('invalid_release', '安装包响应缺少合法的 Content-Length。');
  }

  return {
    protocol: PROTOCOL_VERSION,
    status: 'planned',
    release: tag,
    release_url: `https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}`,
    platform,
    asset: selected.name,
    url,
    size,
    sha256: selected.sha256,
    unsigned: selected.unsigned,
  };
}

/**
 * 流式下载安装包到隔离临时目录，并在写入目标前完成精确字节数与 SHA-256 校验。
 */
export async function downloadReleaseAsset(plan, destination, fetchImpl = fetch) {
  if (!isAbsolute(destination)) {
    fail('invalid_input', '下载目标必须是绝对路径。');
  }
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(join(destination, '.cage-download-'));
  try {
    const tempPath = join(stage, plan.asset);
    const finalPath = join(destination, plan.asset);
    const response = await fetchHttpsStrict(plan.url, fetchImpl);
    const hash = createHash('sha256');
    let bytes = 0;

    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > plan.size) {
          callback(new BootstrapError('size_mismatch', '下载体积超出 Release 声明大小。', 'plan'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    if (bytes !== plan.size || hash.digest('hex') !== plan.sha256) {
      fail('checksum_mismatch', '安装包大小或 SHA-256 校验失败，已自动丢弃临时文件。');
    }
    await chmod(tempPath, 0o600);
    // 使用排他硬链接落盘，绝不静默覆盖既有安装包。
    await link(tempPath, finalPath);
    return { ...plan, status: 'downloaded', path: finalPath };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
