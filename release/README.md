# Narrative Forge Release

[简体中文](#简体中文) · [English](#english)

## 简体中文

### Windows 安装包

[下载 NarrativeForge-Setup.exe](NarrativeForge-Setup.exe?raw=1)

| 项目 | 信息 |
| --- | --- |
| 版本 | `0.1.0` |
| 平台 | Windows 10/11 |
| 文件大小 | 3.93 MiB（4,116,440 字节） |
| SHA-256 | `6714B75BAA8002856607718EC60B4B46B73474EB7882E8851E389A2A874E5B2B` |

安装前请确认电脑已安装 Python 3.10 或更高版本。FFmpeg 仅在导出 AI 短剧分集成片时需要。

安装完成后，从开始菜单或桌面快捷方式启动 Narrative Forge。首次运行会创建本地 Python 虚拟环境并安装所需依赖，因此需要网络连接。

校验安装包：

```powershell
Get-FileHash .\NarrativeForge-Setup.exe -Algorithm SHA256
```

当前安装包尚未进行代码签名，Windows SmartScreen 可能显示未知发布者提示。请核对上方 SHA-256 后再运行。

## English

### Windows Installer

[Download NarrativeForge-Setup.exe](NarrativeForge-Setup.exe?raw=1)

| Item | Value |
| --- | --- |
| Version | `0.1.0` |
| Platform | Windows 10/11 |
| File size | 3.93 MiB (4,116,440 bytes) |
| SHA-256 | `6714B75BAA8002856607718EC60B4B46B73474EB7882E8851E389A2A874E5B2B` |

Python 3.10 or later must be installed before setup. FFmpeg is required only when exporting assembled AI short-drama episodes.

After installation, launch Narrative Forge from the Start menu or desktop shortcut. The first launch creates a local Python virtual environment and installs the required dependencies, so an internet connection is required.

Verify the installer:

```powershell
Get-FileHash .\NarrativeForge-Setup.exe -Algorithm SHA256
```

The installer is currently unsigned. Windows SmartScreen may display an unknown-publisher warning. Verify the SHA-256 checksum above before running it.
