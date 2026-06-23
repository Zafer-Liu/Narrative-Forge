<div align="center">
  <img src="static/logo.png" alt="Narrative Forge Logo" width="160">

  # Narrative Forge

  > A local, human-in-the-loop directing workspace for interactive stories and AI short dramas — from narrative concept to a playable release or exported episode, all in one place.

  [![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
  [![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows)](#quickstart)
  [![Status](https://img.shields.io/badge/status-alpha-E9B45B)](#status)
  [![Download](https://img.shields.io/badge/download-Windows%20installer-5AC39A?logo=windows)](release/NarrativeForge-Setup.exe?raw=1)
  [![License](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](#license)

  [简体中文](README.md) · **English**
</div>

<p align="center">
  <a href="#quickstart">⚡ Quick Start</a> ·
  <a href="#features">✨ Features</a> ·
  <a href="#install">⚙️ Installation</a> ·
  <a href="#workflow">📖 Workflow</a> ·
  <a href="#faq">❓ FAQ</a>
</p>

<details>
<summary><strong>📚 Table of Contents</strong></summary>

<br>

- [Quick Start](#quickstart)
- [Highlights](#highlights)
- [Features](#features)
- [Installation](#install)
- [Provider Compatibility](#compatibility)
- [Workflow](#workflow)
- [Data and Security](#security)
- [Development and Contributing](#development)
- [FAQ](#faq)
- [Project Status](#status)
- [License](#license)

</details>

---

<a id="quickstart"></a>
## ⚡ 30-Second Quick Start

```powershell
# 1. Clone the repository
git clone https://github.com/your-username/Narrative-Forge.git
cd Narrative-Forge

# 2. Install dependencies
python -m pip install -r requirements.txt

# 3. Start the server
python app.py

# 4. Open http://127.0.0.1:8000 in your browser and start creating!
```

> 💡 **Windows users** can also [download the installer](release/NarrativeForge-Setup.exe?raw=1) directly, run it, and launch Narrative Forge from the Start menu. The first launch creates a local virtual environment and installs dependencies automatically.

<details>
<summary>📖 More launch options (start.bat / env vars / API keys)</summary>

### One-Click Launcher

Double-click `start.bat` in the project root. The launcher will:

1. Check the installed Python version (3.10+ required).
2. Create a project-local `.venv`.
3. Install missing dependencies.
4. Start the local service and open the browser.

### API Keys

Text, text-to-image, and image-to-video providers can be configured with separate keys:

```powershell
$env:TEXT_MODEL_API_KEY="your-text-key"
$env:IMAGE_MODEL_API_KEY="your-image-key"
$env:VIDEO_MODEL_API_KEY="your-video-key"
```

Keys entered in the UI are stored only in the current tab's `sessionStorage`. They are not written to project files or exported releases.

</details>

---

<a id="highlights"></a>
## ✨ Highlights

- **All-in-one workspace** — Story planning, shot editing, keyframe generation, image-to-video, asset management, interactive previews, and final exports, all in the browser.
- **Local-first, zero database** — Project data, generated media, and exports stay on your machine by default. No database or cloud service required.
- **Human-in-the-loop** — AI drafts and generates, humans direct every frame. Results can be previewed, regenerated, and replaced.
- **Dual mode: interactive stories + AI short dramas** — The same workspace supports multi-ending story graphs and episodic short dramas.

---

<a id="features"></a>
## 🎬 Features

### Interactive Stories

| Capability | Description |
| --- | --- |
| Story graph generation | Generate story graphs with choices, transitions, and multiple endings via text model or local template |
| Node editing | Configure tree depth and branch count; reorder shots and same-level nodes via drag and drop |
| Visual browsing | Zoom and inspect the complete narrative graph in fullscreen |
| Play from any node | Preview from any node in landscape or `9:16` portrait layouts |
| Offline export | Export a self-contained offline player as a ZIP archive |

### AI Short Dramas

| Capability | Description |
| --- | --- |
| Three-level workflow | Project → episode → individual shot, refined layer by layer |
| Per-episode config | Each episode has its own synopsis, objective, opening hook, climax, and shot count |
| Single-episode generation | Text model or local template generates only the active episode |
| Character consistency | Cross-episode character references improve visual consistency |
| Shot continuity | Manage entry states, exit states, and transitions between adjacent shots |
| MP4 export | Assemble the active episode into an MP4 file with FFmpeg |

### AI and Asset Workflow

| Capability | Description |
| --- | --- |
| Independent model config | Text, text-to-image, reference editing, and image-to-video providers configured separately |
| Prompt synthesis | Automatically merge performance, dialogue, and continuity requirements into prompts |
| Per-shot task tracking | Track generation tasks per shot; stop polling and resume status checks later |
| Asset management | Preview, save, download, delete, and regenerate images and videos |
| Project persistence | Save projects locally and import or export project JSON files |

---

<a id="install"></a>
## ⚙️ Installation

### Requirements

- Windows 10/11
- Python 3.10 or later
- A modern web browser
- At least one compatible model provider and API key
- FFmpeg (required only for short-drama episode exports)

### Option 1: Windows Installer (recommended for general users)

- [Download NarrativeForge-Setup.exe](release/NarrativeForge-Setup.exe?raw=1)
- [Open the release directory](release/)
- [Read installation and checksum information](release/README.md#english)

Python 3.10 or later must already be installed on the target computer. After installation, launch Narrative Forge from the Start menu or desktop shortcut. The first launch creates a local virtual environment and installs dependencies.

> ⚠️ The installer is currently unsigned. Windows SmartScreen may display an unknown-publisher warning. Verify the SHA-256 checksum in [release/README.md](release/README.md#english) before running it.

### Option 2: Run from Source (recommended for developers)

```powershell
python -m pip install -r requirements.txt
python app.py
```

Then open <http://127.0.0.1:8000>.

### Option 3: Build the Installer Yourself

An [Inno Setup](https://jrsoftware.org/isinfo.php) script is included. After installing Inno Setup 6, run:

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "installer\setup.iss"
```

The installer is generated at `release/NarrativeForge-Setup.exe`. Python is not bundled, so the target computer must have Python 3.10 or later installed. After rebuilding a release, update the file size and SHA-256 value in [release/README.md](release/README.md).

---

<a id="compatibility"></a>
## 🔌 Provider Compatibility

| Model type | Required protocol |
| --- | --- |
| Text | OpenAI-compatible Chat Completions API |
| Text-to-image / reference editing | AtlasCloud asynchronous `generateImage` protocol |
| Image-to-video | AtlasCloud asynchronous `generateVideo` protocol |
| Task polling | AtlasCloud `prediction/{id}` protocol |

Text, image, and video models may use different providers. **Changing only the base URL is not enough** for providers with incompatible request or response formats; those providers require a backend adapter (see [development.md](development.md)).

---

<a id="workflow"></a>
## 📖 Workflow

### Interactive Story

1. Define the synopsis, visual direction, and recurring characters.
2. Configure providers and generate a draft story graph.
3. Edit nodes, choices, and transitions, then validate the graph.
4. Generate a character master image before producing later keyframes and videos.
5. Test multiple paths and export the offline player package.

### AI Short Drama

1. Define the series and create an episode plan.
2. Set the active episode's objective, hook, ending, and shot count.
3. Generate and refine the shot list, keeping one narrative beat per shot.
4. Review character references, continuity states, and transitions.
5. Generate media shot by shot, then export the active episode as MP4.

---

<a id="security"></a>
## 🔒 Data and Security

- Projects and generated assets remain local by default.
- API keys are not written to project JSON, media folders, or release packages.
- Release packages omit provider settings, prompts, and internal task metadata.
- The local service has no account system or access control — **do not expose it directly to the public internet**.
- Do not commit `.env`, `projects/`, real API keys, or user media.

---

<a id="development"></a>
## 🛠️ Development and Contributing

Issues and pull requests are welcome. Run the test suite before submitting changes:

```powershell
python -m unittest -v backend.test_server
```

See [development.md](development.md) for the project structure, runtime design, data model, APIs, and extension guidelines.

Tech stack: Python standard-library HTTP server + vanilla HTML/CSS/JavaScript frontend. No frontend framework, no database. The only external HTTP dependency is `requests`.

---

<a id="faq"></a>
## ❓ FAQ

<details>
<summary><b>📦 Installation & Launch</b></summary>

<br>

<details>
<summary><b>start.bat says Python is not found?</b></summary>

`start.bat` looks for Python 3.10+ on your PATH. Make sure [Python 3.10 or later](https://www.python.org/downloads/) is installed and that "Add Python to PATH" was checked during installation. You can verify by running `start.bat --check` from the command line.
</details>

<details>
<summary><b>Dependency installation is slow or times out?</b></summary>

Dependencies are installed from PyPI by default. Use a mirror to speed things up:

```powershell
python -m pip install -r requirements.txt -i https://pypi.org/simple
```
</details>

<details>
<summary><b>The installer triggers a SmartScreen warning?</b></summary>

The installer is currently unsigned, so this is expected. Verify the SHA-256 checksum in [release/README.md](release/README.md#english) first, then click "More info → Run anyway".
</details>

</details>

<details>
<summary><b>🤖 Models & Generation</b></summary>

<br>

<details>
<summary><b>Which model providers are supported?</b></summary>

- **Text**: Any provider compatible with the OpenAI Chat Completions API (e.g. OpenAI, DeepSeek, Moonshot, or a local vLLM/Ollama OpenAI-compatible endpoint).
- **Text-to-image / reference editing / image-to-video**: Currently requires a provider compatible with the AtlasCloud asynchronous protocol. Changing only the base URL is not enough for providers with different protocols; a backend adapter is required.
</details>

<details>
<summary><b>Are API keys safe? Will they be uploaded?</b></summary>

Keys entered in the UI are stored only in the current tab's `sessionStorage`. They are not written to project JSON, media folders, or exported packages. Environment variables likewise stay on the local machine.
</details>

<details>
<summary><b>Generated characters look inconsistent across shots?</b></summary>

Generate a character master image (the first shot's keyframe) first. Subsequent shots use it as a reference to maintain visual consistency. If inconsistency persists, refine the prompt or regenerate the character master.
</details>

</details>

<details>
<summary><b>🎬 Export & Rendering</b></summary>

<br>

<details>
<summary><b>MP4 export fails with "FFmpeg not found"?</b></summary>

Short-drama episode assembly depends on FFmpeg. Download it from [ffmpeg.org](https://ffmpeg.org/download.html), add its `bin` folder to your system PATH, and verify with `ffmpeg -version` before exporting.
</details>

<details>
<summary><b>How do I use the offline interactive-story player?</b></summary>

The exported ZIP contains a standalone player and all local media. Extract it and double-click `index.html` to play in a browser — no workspace or server required.
</details>

</details>

---

<a id="status"></a>
## 📌 Project Status

Narrative Forge is currently in **Alpha**. It is suitable for personal creation and prototyping. Generated media still requires human review, and image/video providers currently need to support the AtlasCloud asynchronous protocol.

---

<a id="license"></a>
## 📄 License

This project is open-sourced under the [Apache License 2.0](LICENSE).
