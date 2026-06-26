<div align="center">
  <img src="static/logo.png" alt="Narrative Forge Logo" width="160">

  # Narrative Forge（叙事锻造工坊）

  > 面向互动影游与 AI 短剧创作的本地半自动导演工作台 —— 从故事构思到可试玩作品或短剧成片，一站完成。

  [![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
  [![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows)](#quickstart)
  [![Status](https://img.shields.io/badge/status-alpha-E9B45B)](#status)
  [![Download](https://img.shields.io/badge/download-Windows%20installer-5AC39A?logo=windows)](release/NarrativeForge-Setup.exe?raw=1)
  [![License](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](#license)

  **简体中文** · [English](README_EN.md)
</div>

<p align="center">
  <a href="#quickstart">⚡ 快速体验</a> ·
  <a href="#features">✨ 功能特性</a> ·
  <a href="#install">⚙️ 安装说明</a> ·
  <a href="#workflow">📖 使用流程</a> ·
  <a href="#faq">❓ FAQ</a>
</p>

<details>
<summary><strong>📚 完整目录</strong></summary>

<br>

- [快速体验](#quickstart)
- [项目亮点](#highlights)
- [功能特性](#features)
- [安装说明](#install)
- [模型兼容性](#compatibility)
- [使用流程](#workflow)
- [数据与安全](#security)
- [开发与贡献](#development)
- [FAQ](#faq)
- [项目状态](#status)
- [许可证](#license)

</details>

---

<a id="quickstart"></a>
## ⚡ 30 秒快速体验

```powershell
# 1. 克隆仓库
git clone https://github.com/你的用户名/Narrative-Forge.git
cd Narrative-Forge

# 2. 安装依赖
python -m pip install -r requirements.txt

# 3. 启动服务
python app.py

# 4. 浏览器打开 http://127.0.0.1:8000，开始创作！
```

> 💡 **Windows 用户**也可直接 [下载安装包](release/NarrativeForge-Setup.exe?raw=1)，双击安装后从开始菜单启动，首次运行会自动创建虚拟环境并安装依赖。

<details>
<summary>📖 更多启动方式（start.bat / 环境变量 / API Key）</summary>

### 一键脚本启动

双击根目录的 `start.bat`，脚本会自动完成：

1. 检测 Python 版本（需 3.10+）
2. 创建项目专用的 `.venv`
3. 安装缺失依赖
4. 启动本地服务并打开浏览器

### 配置 API Key

文本、文生图、图生视频三类模型可分别配置密钥：

```powershell
$env:TEXT_MODEL_API_KEY="your-text-key"
$env:IMAGE_MODEL_API_KEY="your-image-key"
$env:VIDEO_MODEL_API_KEY="your-video-key"
```

界面中填写的临时密钥只保存在当前标签页的 `sessionStorage`，不会写入项目文件或导出包。

</details>

---

<a id="highlights"></a>
## ✨ 项目亮点

- **一站式工作台** —— 故事规划、分镜编辑、关键帧生成、图生视频、素材管理、剧情试玩、成片导出，全部整合在浏览器中。
- **本地优先，零数据库** —— 创作数据、生成素材、导出文件默认保存在本机，无需部署数据库或云端服务。
- **人在回路（Human-in-the-loop）** —— AI 负责起草与生成，人工把控每一帧；生成结果可预览、可重做、可替换。
- **互动影游 + AI 短剧双模式** —— 同一工作台支持多结局剧情树与分集短剧两种创作形态。

---

<a id="features"></a>
## 🎬 功能特性

### 互动影游

| 能力 | 说明 |
| --- | --- |
| 剧情树生成 | 使用文本模型或本地模板生成带选择、跳转和多结局的剧情树 |
| 节点编辑 | 自定义剧情树深度与分支数量，拖拽调整分镜及同层节点顺序 |
| 可视化浏览 | 缩放、全屏查看完整剧情结构 |
| 任意点试玩 | 从任意节点开始试玩，支持横屏与 `9:16` 竖屏画幅 |
| 离线导出 | 导出包含本地素材的离线试玩 ZIP |

### AI 短剧

| 能力 | 说明 |
| --- | --- |
| 三级创作流程 | 项目设定 → 分集设定 → 单镜头，逐层细化 |
| 分集独立配置 | 每集独立设置梗概、叙事目标、开场钩子、高潮和镜头数量 |
| 单集生成 | 文本模型或本地模板仅生成当前集，不覆盖其他分集 |
| 角色一致性 | 跨集角色参考，改善人物外观一致性 |
| 镜头衔接 | 管理相邻镜头的进入状态、离开状态和转场类型 |
| 成片导出 | 使用 FFmpeg 将当前集镜头拼接为独立 MP4（后台任务，实时进度，可随时取消）|

### AI 与素材

| 能力 | 说明 |
| --- | --- |
| 模型独立配置 | 文本、文生图、参考图编辑、图生视频可分别配置供应商 |
| 提示词合成 | 自动将镜头表演、对白和连续性要求合入提示词 |
| 任务跟踪 | 每个镜头独立跟踪生成任务，可停止等待并稍后继续查询 |
| 素材管理 | 支持预览、保存、下载、删除和重新生成图片及视频 |
| 项目持久化 | 支持本地保存以及 JSON 导入、导出 |

---

<a id="install"></a>
## ⚙️ 安装说明

### 环境要求

- Windows 10/11
- Python 3.10 或更高版本
- 现代浏览器
- 至少一个兼容的模型供应商及 API Key
- FFmpeg（仅短剧成片导出需要）

### 方式一：Windows 安装包（推荐普通用户）

- [直接下载 NarrativeForge-Setup.exe](release/NarrativeForge-Setup.exe?raw=1)
- [打开 release 目录](release/)
- [查看安装说明与 SHA-256 校验值](release/README.md)

安装包需要目标电脑预先安装 Python 3.10 或更高版本。安装完成后，从开始菜单或桌面快捷方式启动，首次运行会自动创建本地虚拟环境并安装依赖。

> ⚠️ 当前安装包未进行代码签名，Windows SmartScreen 可能显示未知发布者提示，请核对 [release/README.md](release/README.md) 中的 SHA-256 后再运行。

### 方式二：源码运行（推荐开发者）

```powershell
python -m pip install -r requirements.txt
python app.py
```

然后访问 <http://127.0.0.1:8000>。

### 方式三：自行构建安装包

项目提供 [Inno Setup](https://jrsoftware.org/isinfo.php) 构建脚本。安装 Inno Setup 6 后运行：

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "installer\setup.iss"
```

安装程序将生成到 `release/NarrativeForge-Setup.exe`。Python 不会被打入安装包，目标电脑仍需安装 Python 3.10+。重新发布安装包后，请同步更新 [release/README.md](release/README.md) 中的文件大小和 SHA-256。

---

<a id="compatibility"></a>
## 🔌 模型兼容性

| 模型类型 | 内置可选供应商 |
| --- | --- |
| 文本模型 | 任意 OpenAI Chat Completions 兼容接口 |
| 文生图 / 参考图编辑 | AtlasCloud 异步协议 · OpenAI 兼容图像（`/images/generations`）· 阿里通义万相（DashScope） |
| 图生视频 | AtlasCloud 异步协议 · 火山方舟 Seedance · 阿里通义万相（DashScope） |

文本、图片和视频可分别选择不同供应商。文生图与图生视频在设置区提供**供应商下拉**与**测试连接**按钮（测试连接为零成本的连通性+鉴权校验，不会真正生成素材或扣费）。切换供应商会自动填入该供应商推荐的 Base URL 与模型 ID。

如需接入更多协议不同的供应商，在 `backend/providers.py` 中实现一个适配器子类并注册即可，无需改动核心流程（参见 [development.md](development.md)）。

---

<a id="workflow"></a>
## 📖 使用流程

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

---

<a id="security"></a>
## 🔒 数据与安全

- 项目数据和生成素材默认保存在本机。
- API Key 不会写入项目 JSON、素材目录或发布包。
- 发布包会移除供应商配置、提示词和内部任务信息。
- 本地服务不包含账号和访问控制，**请勿直接暴露到公网**。
- 不要提交 `.env`、`projects/`、真实密钥或用户素材。

---

<a id="development"></a>
## 🛠️ 开发与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行测试：

```powershell
python -m unittest -v backend.test_server
```

前端源码位于 `static/src/`（ES Module），由 esbuild 打包为运行时单文件 `static/dist/bundle.js`。修改前端后需重新构建并运行前端测试：

```powershell
npm install          # 仅首次：安装 esbuild / vitest（开发期依赖）
npm run build        # 打包到 static/dist/bundle.js
npm test             # 运行 Vitest 前端单元 / 冒烟测试
npm run watch        # 开发时自动重建
```

> 运行时仍是零依赖静态文件：Python 标准库 HTTP 服务直接托管打包产物，无需 Node。`node_modules/` 仅在开发期需要。

项目结构、运行逻辑、数据模型、接口和扩展方式请参阅 [development.md](development.md)。

技术栈：Python 标准库 HTTP 服务 + 原生 HTML/CSS/JavaScript 前端，无前端框架，无数据库，外部 HTTP 请求仅依赖 `requests`。

---

<a id="faq"></a>
## ❓ FAQ

<details>
<summary><b>📦 安装与启动</b></summary>

<br>

<details>
<summary><b>双击 start.bat 提示找不到 Python？</b></summary>

`start.bat` 会在 PATH 中查找 Python 3.10+。请确认已安装 [Python 3.10 或更高版本](https://www.python.org/downloads/)，安装时勾选 "Add Python to PATH"。也可在命令行手动运行 `start.bat --check` 验证。
</details>

<details>
<summary><b>首次启动安装依赖很慢或超时？</b></summary>

默认从 PyPI 安装。可配置国内镜像加速：

```powershell
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```
</details>

<details>
<summary><b>安装包运行时弹出 SmartScreen 警告？</b></summary>

当前安装包未进行代码签名，属于正常现象。请先在 [release/README.md](release/README.md) 核对 SHA-256 校验值，确认一致后点击 "更多信息 → 仍要运行"。
</details>

</details>

<details>
<summary><b>🤖 模型与生成</b></summary>

<br>

<details>
<summary><b>支持哪些模型供应商？</b></summary>

- **文本模型**：任何兼容 OpenAI Chat Completions 接口的供应商（如 OpenAI、DeepSeek、Moonshot、本地 vLLM/Ollama 的 OpenAI 兼容端点等）。
- **文生图 / 参考图编辑 / 图生视频**：目前需要兼容 AtlasCloud 异步协议的供应商。仅改 Base URL 无法适配协议不同的供应商，需要后端适配器。
</details>

<details>
<summary><b>API Key 安全吗？会被上传吗？</b></summary>

界面中填写的临时密钥只保存在当前标签页的 `sessionStorage`，不会写入项目 JSON、素材目录或导出包。环境变量方式也仅存在于本机进程。
</details>

<details>
<summary><b>生成的图片/视频人物不一致怎么办？</b></summary>

先生成角色母版（首镜头关键帧），后续分镜会以此为参考保持人物外观一致。如仍不一致，可手动调整提示词或重新生成角色母版。
</details>

</details>

<details>
<summary><b>🎬 导出与成片</b></summary>

<br>

<details>
<summary><b>导出短剧 MP4 提示找不到 FFmpeg？</b></summary>

短剧成片拼接依赖 FFmpeg。请从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载并将其 `bin` 目录加入系统 PATH，运行 `ffmpeg -version` 验证可用后再导出。
</details>

<details>
<summary><b>互动影游的离线试玩包怎么用？</b></summary>

导出的 ZIP 内含独立播放器和全部本地素材，解压后直接双击 `index.html` 即可在浏览器中试玩，无需启动工作台或服务器。
</details>

</details>

---

<a id="status"></a>
## 📌 项目状态

Narrative Forge 当前处于 **Alpha** 阶段，适合个人创作和原型验证。生成结果仍需人工审核，图片与视频供应商目前需要兼容 AtlasCloud 异步协议。

---

<a id="license"></a>
## 📄 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。
