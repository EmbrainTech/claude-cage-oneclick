# 常见问题排查

## 1. Windows 家庭版提示未启用 HypervisorPlatform / WHPX

Claude Cage 的 Linux 隔离环境在 Windows 10 22H2 / 11 家庭版即可运行，不需要完整的 Hyper-V 角色，只需启用 **Windows 虚拟机监控程序平台 (`HypervisorPlatform`)**。

以管理员身份运行：

```powershell
.\scripts\Enable-CageHypervisor.ps1 -Apply
```

启用后重启一次 Windows，再运行 `node .\bin\cage-oneclick.mjs preflight` 确认 `whpx_feature` 与 `qemu_whpx` 均为 `ok`。

## 2. 下载 GitHub Release 报 TLS 吊销检查或连接超时

- 本项目在 PowerShell 入口中默认自动启用 Node 24 的 `--use-env-proxy`，并探测本机常见代理端口供安装器下载阶段使用。
- 若使用系统自带 `curl.exe` 手动排查，Windows Schannel 在部分代理环境下会因 CRL 离线检查报错 (`CRYPT_E_REVOCATION_OFFLINE`)，可附加 `--ssl-no-revoke`。

## 3. 避免 C 盘空间爆满

Linux 虚拟机初始虚拟磁盘上限为 24 GiB，外加镜像缓存可能占用较大空间。当本机存在可用空间充足的固定 `D:` 盘时，本工具默认将程序安装到 `D:\Cage`，并将虚拟磁盘存储目录绑定为 `D:\Cage\CageData`。

## 4. 找回自动生成的本机账户密码与恢复密钥

首次通过 `setup` 或 `deploy` 自动创建账户时，用户名、高强度随机密码及 `recovery_key` 会写入受权限保护的文件：

`%USERPROFILE%\.claude-cage\LOCAL_CREDENTIALS.txt`

请勿将该文件分享或提交到任何 Git 仓库。建议在首次打开 `Cage.exe` 登录后启用「记住我」。

## 5. 首次创建虚拟机时 `apt-get update` 报 `Connection failed [IP: ... 80]`

部分住宅 IP 代理节点（例如只放行 443 端口 HTTPS 的独享住宅节点）会屏蔽 **TCP 80 端口（明文 HTTP）**。而 Cage 首次初始化 Linux 客机时，引导脚本需要先通过 HTTP 80 端口请求软件源（如 `http://deb.debian.org/debian-security` 或 `http://archive.ubuntu.com`）。

若遇到：
- `settings.probe`（HTTPS 443）正常返回出口 IP
- 但 `environment.start` 在安装软件包阶段报 `Connection failed [IP: ... 80]`

排查与解决方式：
1. **等待上游合入 HTTPS 回退后直接升级（推荐，零第三方节点风险）**：上游修复跟踪见 [Lee-xeo/Claude-Cage#697](https://github.com/Lee-xeo/Claude-Cage/issues/697)。待官方为 `apt-bootstrap.sh` 增加 `https://` 回退并发布新版后，直接运行 `.\scripts\OneClick-Deploy.ps1`（或 `node .\bin\cage-oneclick.mjs install --version <新版本>`）覆盖升级即可保留现有账户、配置与镜像缓存。
2. **协议验证**：在本机执行 `curl.exe -x http://127.0.0.1:7897 -I http://deb.debian.org/debian-security/dists/trixie-security/InRelease` 与 `https://deb.debian.org/debian-security/dists/trixie-security/InRelease`，若 `http://` 返回 `502 Bad Gateway` 而 `https://` 返回 `200 OK`，即可确认是出口节点屏蔽了 80 端口。
3. **节点放行或干净节点**：联系代理服务商放行出站 TCP 80 端口，或在新建虚拟机阶段使用独立自建节点完成一次 `environment.start` 后再切回原住宅 IP 节点。

