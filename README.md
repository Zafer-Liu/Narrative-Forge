<div align="center">
  <img src="static/logo.png" alt="Narrative Forge Logo" width="160">

  # Narrative Forge（叙事锻造工坊）

  面向互动影游与 AI 短剧创作的本地半自动导演工作台

  [![Status](https://img.shields.io/badge/status-alpha-E9B45B)](#项目状态)
  [![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
  [![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows)](#快速开始)
  [![Download](https://img.shields.io/badge/download-Windows%20installer-5AC39A?logo=windows)](release/NarrativeForge-Setup.exe?raw=1)
  [![License](https://img.shields.io/badge/license-not%20selected-lightgrey)](#许可证)

  **简体中文** · [English](README_EN.md)
</div>

## 简介

Narrative Forge 将故事规划、分镜编辑、关键帧生成、图生视频、素材管理、剧情试玩和成片导出整合到一个浏览器工作台中。

它适合个人创作者、小型团队和原型设计者在本地完成从故事构思到可试玩互动作品或短剧分集成片的制作流程。项目不依赖数据库，创作数据、生成素材和导出文件默认保存在本机。

## 功能

### 互动影游

- 生成并编辑具有选择、跳转和多个结局的剧情树。
- 自定义剧情树深度和节点分支数量。
- 拖拽调整分镜及同层剧情节点顺序。
- 可视化浏览、缩放和全屏查看剧情结构。
- 从任意节点开始试玩，支持横屏及 `9:16` 竖屏画幅。
- 导出包含本地素材的离线试玩 ZIP。

### AI 短剧

- 使用“项目设定 → 分集设定 → 单镜头”三级创作流程。
- 每集独立配置梗概、叙事目标、开场钩子、高潮和镜头数量。
- 文本模型或本地模板仅生成当前集，不覆盖其他分集。
- 支持跨集角色参考，改善人物外观一致性。
- 管理相邻镜头的进入状态、离开状态和转场类型。
- 使用 FFmpeg 将当前集镜头拼接为独立 MP4 成片。

### AI 与素材

- 文本、文生图、参考图编辑和图生视频模型可分别配置。
- 自动将镜头表演、对白和连续性要求合入提示词。
- 每个镜头独立跟踪生成任务，可停止等待并稍后继续查询。
- 支持预览、保存、下载、删除和重新生成图片及视频。
- 项目支持本地保存以及 JSON 导入、导出。

## 快速开始

> **Windows 用户：** [直接下载安装包](release/NarrativeForge-Setup.exe?raw=1) · [查看发行文件与校验信息](release/)

### 环境要求

- Windows 10/11
- Python 3.10 或更高版本
- 现代浏览器
- 至少一个兼容的模型供应商及 API Key
- FFmpeg（仅短剧成片导出需要）

### 一键启动

双击根目录中的 `start.bat`。脚本会自动：

1. 检测 Python 版本。
2. 创建项目专用的 `.venv`。
3. 安装缺失依赖。
4. 启动本地服务并打开浏览器。

也可以手动启动：

```powershell
python -m pip install -r requirements.txt
python app.py
```

然后访问 <http://127.0.0.1:8000>。

### 配置 API Key

可以分别配置：

```powershell
$env:TEXT_MODEL_API_KEY="your-text-key"
$env:IMAGE_MODEL_API_KEY="your-image-key"
$env:VIDEO_MODEL_API_KEY="your-video-key"
```

界面中填写的临时密钥只保存在当前标签页的 `sessionStorage`，不会写入项目文件或导出包。

## 模型兼容性

| 模型类型 | 所需协议 |
| --- | --- |
| 文本模型 | OpenAI Chat Completions 兼容接口 |
| 文生图 / 参考图编辑 | AtlasCloud `generateImage` 异步协议 |
| 图生视频 | AtlasCloud `generateVideo` 异步协议 |
| 任务查询 | AtlasCloud `prediction/{id}` 查询协议 |

文本、图片和视频可以使用不同供应商。仅修改 Base URL 并不能适配协议不同的供应商，此类供应商需要增加后端适配器。

## 使用流程

### 制作互动影游

1. 填写故事梗概、视觉风格和角色设定。
2. 配置模型并生成剧情树草案。
3. 编辑节点、选择和剧情跳转，检查分支完整性。
4. 先生成角色母版，再逐镜生成关键帧和视频。
5. 试玩不同路线并导出离线试玩包。

### 制作 AI 短剧

1. 填写全剧设定并建立分集计划。
2. 配置当前集的目标、钩子、结尾和镜头数量。
3. 生成并调整分镜，确保一个镜头只承担一个剧情节拍。
4. 检查角色参考、镜头状态和转场衔接。
5. 逐镜生成素材，完成后导出当前集 MP4。

## Windows 安装包

### 下载安装

- [直接下载 NarrativeForge-Setup.exe](release/NarrativeForge-Setup.exe?raw=1)
- [打开 release 目录](release/)
- [查看安装说明与 SHA-256 校验值](release/README.md)

安装包需要目标电脑预先安装 Python 3.10 或更高版本。

### 自行构建

项目提供 [Inno Setup](https://jrsoftware.org/isinfo.php) 构建脚本。安装 Inno Setup 6 后运行：

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "installer\setup.iss"
```

安装程序将生成到 `release/NarrativeForge-Setup.exe`。Python 不会被打入安装包，目标电脑仍需安装 Python 3.10 或更高版本。重新发布安装包后，请同步更新 [release/README.md](release/README.md) 中的文件大小和 SHA-256。

## 数据与安全

- 项目数据和生成素材默认保存在本机。
- API Key 不会写入项目 JSON、素材目录或发布包。
- 发布包会移除供应商配置、提示词和内部任务信息。
- 本地服务不包含账号和访问控制，请勿直接暴露到公网。
- 不要提交 `.env`、`projects/`、真实密钥或用户素材。

## 开发与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行测试：

```powershell
python -m unittest -v backend.test_server
```

项目结构、运行逻辑、数据模型、接口和扩展方式请参阅 [development.md](development.md)。

## 项目状态

Narrative Forge 当前处于 **Alpha** 阶段，适合个人创作和原型验证。生成结果仍需人工审核，图片与视频供应商目前需要兼容 AtlasCloud 异步协议。

## 许可证

仓库目前尚未包含开源许可证。在维护者添加 `LICENSE` 文件之前，代码不应被视为已经获得复制、修改或再分发授权。
