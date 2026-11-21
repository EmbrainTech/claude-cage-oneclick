# 代理迁移与导入预检指南

Claude Cage 内置独立的 Mihomo 核心用于接管虚拟机全部流量，默认阻断回环地址与直连回退。因此，直接将本地代理客户端的端口（例如 `127.0.0.1:7897` 或 `127.0.0.1:10808`）当作出口节点会触发阻断。

## 正确迁移步骤

1. **导出含真实节点的配置**：
   - **Clash Verge Rev / Mihomo Party**：导出当前配置文件（`.yaml`），确认文件中包含 `proxies:` 列表；若原订阅仅含远程 `proxy-providers`，建议直接使用订阅链接导入。
   - **v2rayN**：选中需要的中转与出口节点，右键「导出所选服务器为分享链接」并保存为 `.txt`。
2. **运行离线导入预检（不触碰后台、不泄露凭据）**：
   ```powershell
   node .\bin\cage-oneclick.mjs proxy-check --yaml C:\path\to\nodes.yaml
   ```
   工具会检查：
   - 节点数量是否在 `1–3000` 之间
   - 是否误用了 `127.0.0.1` / `localhost` 回环地址
   - 节点名称是否重复、`dialer-proxy` 代理链是否存在循环或引用无效分组
   - SSH 节点 `private-key` 是否内联 PEM 文本（禁止引用本机路径）
   - 旧版 WebSocket (`ws-path` / `ws-headers`) 与 Hysteria2 (`pinSHA256`) 参数合法性
3. **一键导入、探测出口并启动隔离环境**：
   ```powershell
   # 方式 A：通过本地 YAML 文件
   node .\bin\cage-oneclick.mjs proxy-onboard --yaml C:\path\to\nodes.yaml --start-guest

   # 方式 B：通过 HTTPS 订阅链接
   node .\bin\cage-oneclick.mjs proxy-onboard --subscription "https://example.com/sub" --start-guest
   ```
   也可以直接打开 `D:\Cage\Cage.exe` 图形工作台完成导入与节点测速。
