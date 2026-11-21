import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 评估 Windows Authenticode 签名对象是否满足安装信任策略。
 */
export function evaluateSignature(sig, { allowUnsigned = false } = {}) {
  if (!sig || typeof sig !== 'object') {
    return {
      trusted: false,
      status: 'Unknown',
      reason: '未能读取签名信息',
    };
  }
  const status = String(sig.status || sig.Status || 'Unknown');
  const subject = String(sig.subject || sig.Subject || '');
  const issuer = String(sig.issuer || sig.Issuer || '');
  const thumbprint = String(sig.thumbprint || sig.Thumbprint || '');

  if (status === 'Valid') {
    return {
      trusted: true,
      status,
      subject,
      issuer,
      thumbprint,
      reason: 'Authenticode 数字签名校验通过',
    };
  }
  if (status === 'NotSigned' && allowUnsigned) {
    return {
      trusted: true,
      status,
      subject,
      issuer,
      thumbprint,
      reason: '用户显式允许未签名预览安装包 (--allow-unsigned)',
    };
  }
  return {
    trusted: false,
    status,
    subject,
    issuer,
    thumbprint,
    reason: `安装包数字签名未通过验证 (${status})`,
  };
}

/**
 * 调用本机 PowerShell Get-AuthenticodeSignature 检验 PE 安装包签名与发布者证书。
 */
export async function inspectAuthenticode(filePath, { allowUnsigned = false } = {}) {
  if (process.platform !== 'win32') {
    return {
      trusted: false,
      status: 'UnsupportedPlatform',
      reason: 'Authenticode 检查仅在 Windows 主机可执行',
    };
  }
  const escaped = filePath.replace(/'/g, "''");
  const script = `
    $s = Get-AuthenticodeSignature -LiteralPath '${escaped}';
    @{
      status = [string]$s.Status
      statusMessage = [string]$s.StatusMessage
      subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { '' }
      issuer = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Issuer } else { '' }
      thumbprint = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint } else { '' }
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15000, windowsHide: true }
  );
  const parsed = JSON.parse(stdout.trim());
  return evaluateSignature(parsed, { allowUnsigned });
}
