const SUPPORTED_TYPES = new Set([
  'http',
  'socks5',
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'anytls',
  'mieru',
  'ssh',
]);

const SHARE_SCHEME_MAP = {
  trojan: 'trojan',
  vless: 'vless',
  vmess: 'vmess',
  ss: 'ss',
  hysteria2: 'hysteria2',
  hy2: 'hysteria2',
  tuic: 'tuic',
  anytls: 'anytls',
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquoteScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function splitTopLevelCommas(inner) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && inner[i - 1] !== '\\') inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseFlowObject(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const obj = {};
  for (const part of splitTopLevelCommas(trimmed.slice(1, -1))) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const key = unquoteScalar(part.slice(0, colon).trim());
    const valRaw = part.slice(colon + 1).trim();
    if (valRaw.startsWith('{') && valRaw.endsWith('}')) {
      obj[String(key)] = parseFlowObject(valRaw);
    } else {
      obj[String(key)] = unquoteScalar(valRaw);
    }
  }
  return obj;
}

/**
 * 轻量解析 Clash/Mihomo YAML 中的 proxies / payload 节点列表，避免引入第三方 YAML 依赖。
 */
export function extractYamlProxyNodes(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  let inSection = false;
  let sectionIndent = -1;
  let itemIndent = -1;
  const nodes = [];
  let current = null;
  let nestedKey = null;
  let nestedIndent = -1;
  let blockScalarKey = null;
  let blockScalarIndent = -1;
  let blockScalarLines = [];

  const flushBlockScalar = () => {
    if (current && blockScalarKey) {
      current[blockScalarKey] = blockScalarLines.join('\n');
    }
    blockScalarKey = null;
    blockScalarIndent = -1;
    blockScalarLines = [];
  };

  for (const rawLine of lines) {
    if (blockScalarKey) {
      const indentMatch = rawLine.match(/^(\s*)(.*)$/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (rawLine.trim() === '' || indent > blockScalarIndent) {
        blockScalarLines.push(rawLine.slice(Math.min(indent, blockScalarIndent + 2)));
        continue;
      }
      flushBlockScalar();
    }

    const cleaned = stripYamlComment(rawLine);
    if (!cleaned.trim()) continue;
    const indent = cleaned.match(/^(\s*)/)[1].length;
    const trimmed = cleaned.trim();

    if (!inSection) {
      if (indent === 0 && /^(proxies|payload)\s*:\s*$/.test(trimmed)) {
        inSection = true;
        sectionIndent = indent;
        itemIndent = -1;
      }
      continue;
    }

    if (indent <= sectionIndent && !trimmed.startsWith('- ')) {
      if (current) nodes.push(current);
      current = null;
      if (indent === 0 && /^(proxies|payload)\s*:\s*$/.test(trimmed)) {
        sectionIndent = indent;
        itemIndent = -1;
        continue;
      }
      inSection = false;
      itemIndent = -1;
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (itemIndent === -1) itemIndent = indent;
      if (indent !== itemIndent) {
        // 属于当前节点内部的嵌套列表项（如 alpn / ports），不视为新节点。
        continue;
      }
      if (current) nodes.push(current);
      nestedKey = null;
      const body = trimmed.slice(2).trim();
      if (body.startsWith('{') && body.endsWith('}')) {
        nodes.push(parseFlowObject(body) || {});
        current = null;
        continue;
      }
      current = {};
      const kv = body.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) {
        const [, k, v] = kv;
        if (v === '|' || v === '|-') {
          blockScalarKey = k;
          blockScalarIndent = indent + 2;
        } else if (v === '') {
          nestedKey = k;
          nestedIndent = indent + 2;
          current[k] = {};
        } else {
          current[k] = v.startsWith('{') ? parseFlowObject(v) : unquoteScalar(v);
        }
      }
      continue;
    }

    if (!current) continue;
    const kv = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (nestedKey && indent > nestedIndent && typeof current[nestedKey] === 'object' && current[nestedKey] !== null) {
      current[nestedKey][k] = v.startsWith('{') ? parseFlowObject(v) : unquoteScalar(v);
      continue;
    }
    nestedKey = null;
    if (v === '|' || v === '|-') {
      blockScalarKey = k;
      blockScalarIndent = indent;
    } else if (v === '') {
      nestedKey = k;
      nestedIndent = indent;
      current[k] = {};
    } else {
      current[k] = v.startsWith('{') ? parseFlowObject(v) : unquoteScalar(v);
    }
  }
  flushBlockScalar();
  if (current) nodes.push(current);
  return nodes;
}

const canonicalKey = (k) => String(k).toLowerCase().replaceAll('_', '-');

function hasOptionAlias(node, canonical) {
  return Object.keys(node).filter((k) => canonicalKey(k) === canonical);
}

function getOption(node, canonical) {
  const key = Object.keys(node).find((k) => canonicalKey(k) === canonical);
  return key ? node[key] : undefined;
}

function parseShareLinks(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0 || !lines.some((l) => /^[a-z0-9]+:\/\//i.test(l))) {
    return null;
  }
  const nodes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const schemeMatch = line.match(/^([a-z0-9]+):\/\//i);
    if (!schemeMatch) continue;
    const scheme = schemeMatch[1].toLowerCase();
    const mappedType = SHARE_SCHEME_MAP[scheme] || scheme;
    if (scheme === 'vmess') {
      try {
        const decoded = JSON.parse(Buffer.from(line.slice(8), 'base64').toString('utf8'));
        nodes.push({
          name: decoded.ps || `vmess-${i + 1}`,
          type: 'vmess',
          server: decoded.add || '',
          port: Number(decoded.port || 0),
        });
        continue;
      } catch {
        nodes.push({ name: `vmess-${i + 1}`, type: 'vmess', server: '', _parseError: 'VMess Base64 JSON 无法解析' });
        continue;
      }
    }
    try {
      const parsed = new URL(line);
      const name = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : `${mappedType}-${i + 1}`;
      nodes.push({
        name,
        type: mappedType,
        server: parsed.hostname || '',
        port: Number(parsed.port || 0),
      });
    } catch {
      nodes.push({ name: `${mappedType}-${i + 1}`, type: mappedType, server: '', _parseError: '分享链接格式无效' });
    }
  }
  return nodes;
}

/**
 * 对 Clash/Mihomo YAML 或节点分享链接做 Cage 导入前预检，输出脱敏的节点级诊断结果。
 * 绝不回显密码、UUID、私钥或原始分享链接。
 */
export function validateProxyConfig(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return { valid: false, format: 'empty', total: 0, usable: 0, issues: [{ index: 0, reason: '配置内容为空' }], warnings: [] };
  }
  if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) {
    return { valid: false, format: 'oversized', total: 0, usable: 0, issues: [{ index: 0, reason: '配置超过 8 MiB 上限' }], warnings: [] };
  }

  const shareNodes = parseShareLinks(text);
  const format = shareNodes ? 'share_links' : 'yaml';
  const nodes = shareNodes || extractYamlProxyNodes(text);

  if (nodes.length === 0 || nodes.length > 3000) {
    return {
      valid: false,
      format,
      total: nodes.length,
      usable: 0,
      issues: [{ index: 0, reason: '需要包含 1–3000 个有效节点（仅含远程 provider 的订阅请改用订阅链接导入）' }],
      warnings: [],
    };
  }

  const nameCounts = new Map();
  for (const n of nodes) {
    const name = String(n.name || '');
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  const issues = [];
  const warnings = [];
  const validByName = new Map();

  nodes.forEach((node, idx) => {
    const index = idx + 1;
    const name = typeof node.name === 'string' ? node.name : String(node.name || '');
    const type = String(node.type || '');
    const server = String(node.server || '');
    const addIssue = (reason) => issues.push({ index, name: name.slice(0, 60), type, reason });

    if (node._parseError) return addIssue(node._parseError);
    if (!name.trim() || name.length > 240) return addIssue('节点名称为空或超过 240 字符');
    if (nameCounts.get(name) > 1) return addIssue('节点名称重复，无法用于代理链引用');
    if (!SUPPORTED_TYPES.has(type)) return addIssue(`协议暂不支持: ${type || '未知'}`);
    if (!server || server.length > 253) return addIssue('缺少节点 server 地址或超过 253 字符');

    for (const key of ['name', 'type', 'server', 'udp', 'dialer-proxy']) {
      if (hasOptionAlias(node, key).length > 1) {
        return addIssue(`节点字段 ${key} 存在下划线/连字符重复写法`);
      }
    }

    if (LOOPBACK_HOSTS.has(server.toLowerCase())) {
      warnings.push({
        index,
        name: name.slice(0, 60),
        code: 'loopback_node_trap',
        reason: `节点指向本机回环地址 (${server})，Cage 内置核心要求填写真实远端出口节点`,
      });
    }

    if (type === 'ssh') {
      const pk = getOption(node, 'private-key');
      if (pk !== undefined && (typeof pk !== 'string' || !pk.includes('PRIVATE KEY'))) {
        return addIssue('SSH 节点的 private-key 必须直接内联 PEM 私钥文本，禁止引用本机文件路径');
      }
    }

    const hasLegacyWs = getOption(node, 'ws-path') !== undefined || getOption(node, 'ws-headers') !== undefined;
    if (hasLegacyWs) {
      if (!['vmess', 'vless', 'trojan'].includes(type)) {
        return addIssue('旧字段 ws-path/ws-headers 仅适用于 vmess、vless 或 trojan');
      }
      if (getOption(node, 'network') !== 'ws') {
        return addIssue('使用 ws-path/ws-headers 时必须显式设置 network: ws');
      }
    }

    if (type === 'hysteria2') {
      const pin = getOption(node, 'pinsha256') ?? getOption(node, 'fingerprint');
      if (pin !== undefined) {
        const cleanHex = String(pin).replaceAll(':', '').trim();
        if (!/^[a-fA-F0-9]{64}$/.test(cleanHex)) {
          return addIssue('Hysteria2 的 pinSHA256/fingerprint 不是合法的 SHA-256 十六进制指纹');
        }
      }
    }

    validByName.set(name, node);
  });

  // 检验 dialer-proxy 引用完整性与循环依赖。
  const visiting = new Set();
  const visited = new Set();
  const checkChain = (name, idx) => {
    if (visited.has(name)) return true;
    if (visiting.has(name)) {
      issues.push({ index: idx, name: name.slice(0, 60), type: String(validByName.get(name)?.type || ''), reason: '代理链 dialer-proxy 存在循环引用' });
      return false;
    }
    const node = validByName.get(name);
    if (!node) return false;
    const dialer = getOption(node, 'dialer-proxy');
    if (dialer === undefined || dialer === '') {
      visited.add(name);
      return true;
    }
    if (typeof dialer !== 'string' || !validByName.has(dialer)) {
      issues.push({ index: idx, name: name.slice(0, 60), type: String(node.type || ''), reason: 'dialer-proxy 必须引用同一配置中的有效具体节点，不能引用 DIRECT 或策略组' });
      return false;
    }
    visiting.add(name);
    const ok = checkChain(dialer, idx);
    visiting.delete(name);
    if (ok) visited.add(name);
    return ok;
  };

  let usable = 0;
  nodes.forEach((node, idx) => {
    const name = String(node.name || '');
    if (validByName.has(name) && checkChain(name, idx + 1)) {
      usable += 1;
    }
  });

  return {
    valid: issues.length === 0 && usable > 0,
    format,
    total: nodes.length,
    usable,
    issues,
    warnings,
  };
}
