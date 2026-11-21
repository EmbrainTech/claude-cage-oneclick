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
