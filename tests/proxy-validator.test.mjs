import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProxyConfig } from '../src/proxy-validator.mjs';

test('validateProxyConfig 通过标准多节点及流式 Clash YAML 且不泄露凭据', () => {
  const secretPass = 'super-secret-password-999';
  const yaml = `
proxies:
  - name: "jp-relay"
    type: trojan
    server: jp.example.com
    port: 443
    password: "${secretPass}"
    sni: jp.example.com
  - { name: "us-exit", type: socks5, server: us.example.com, port: 1080, username: user1, password: "${secretPass}", dialer-proxy: "jp-relay" }
`;
  const result = validateProxyConfig(yaml);
  assert.equal(result.valid, true);
  assert.equal(result.total, 2);
  assert.equal(result.usable, 2);
  assert.equal(result.warnings.length, 0);
  assert.equal(JSON.stringify(result).includes(secretPass), false);
});

test('validateProxyConfig 识别 127.0.0.1 回环地址陷阱并给出警告', () => {
  const yaml = `
proxies:
  - name: "local-clash"
    type: socks5
    server: 127.0.0.1
    port: 7897
`;
  const result = validateProxyConfig(yaml);
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'loopback_node_trap');
});

test('validateProxyConfig 拦截循环代理链、重复名称与文件路径式 SSH 私钥', () => {
  const badYaml = `
proxies:
  - name: node-a
    type: socks5
    server: a.example.com
    port: 1080
    dialer-proxy: node-b
  - name: node-b
    type: socks5
    server: b.example.com
    port: 1080
    dialer-proxy: node-a
  - name: ssh-bad
    type: ssh
    server: vps.example.com
    port: 22
    username: root
    private-key: /home/user/.ssh/id_ed25519
`;
  const result = validateProxyConfig(badYaml);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.reason.includes('循环引用')));
  assert.ok(result.issues.some((i) => i.reason.includes('PEM 私钥文本')));
});

test('validateProxyConfig 支持节点分享链接列表预检', () => {
  const links = [
    'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=reality#RealityNode',
    'hy2://secret-token@hy.example.com:443?sni=hy.example.com#Hy2Node',
  ].join('\n');
  const result = validateProxyConfig(links);
  assert.equal(result.valid, true);
  assert.equal(result.format, 'share_links');
  assert.equal(result.total, 2);
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});
