/**
 * Agent 剧情对话面板
 * 悬浮侧边抽屉，支持多轮对话、SSE 流式输出、<think> 思考折叠、Markdown 渲染、update_scene 一键应用。
 */
import { project } from "./state.js";
import { providerSettings, selectedScene } from "./project-model.js";
import { showToast } from "./utils.js";
import { render } from "./render.js";

// ── 会话历史（前端本地维护，只含 user/assistant 角色） ───────────────────────
const agentHistory = [];

// ── 待应用的 patch 暂存区 ────────────────────────────────────────────────────
let pendingPatches = [];

// ── DOM 引用 ─────────────────────────────────────────────────────────────────
let panel, chatLog, inputEl, sendBtn, clearBtn, toggleBtn;
let isExpanded = false; // 放大状态

// ─────────────────────────────────────────────────────────────────────────────
//  初始化
// ─────────────────────────────────────────────────────────────────────────────

export function initAgentPanel() {
  _buildDOM();
  _bindEvents();
}

function _buildDOM() {
  toggleBtn = document.createElement("button");
  toggleBtn.id = "agentToggleBtn";
  toggleBtn.className = "agent-toggle-btn";
  toggleBtn.title = "AI 剧情助手";
  toggleBtn.textContent = "✦ 助手";
  document.body.appendChild(toggleBtn);

  panel = document.createElement("div");
  panel.id = "agentPanel";
  panel.className = "agent-panel";
  panel.innerHTML = `
    <div class="agent-panel-header">
      <span class="agent-panel-title">✦ AI 剧情助手</span>
      <div class="agent-panel-actions">
        <button id="agentExpandBtn" class="button ghost agent-btn-sm" title="放大/还原">⤢</button>
        <button id="agentClearBtn" class="button ghost agent-btn-sm" title="清除对话">清空</button>
        <button id="agentCloseBtn" class="button ghost agent-btn-sm" title="关闭">×</button>
      </div>
    </div>
    <div id="agentChatLog" class="agent-chat-log"></div>
    <div class="agent-input-row">
      <textarea id="agentInput" class="agent-input" rows="2"
        placeholder="描述你想修改的剧情…（Enter 发送，Shift+Enter 换行）"></textarea>
      <button id="agentSendBtn" class="button primary agent-send-btn">发送</button>
    </div>
  `;
  document.body.appendChild(panel);

  chatLog = panel.querySelector("#agentChatLog");
  inputEl = panel.querySelector("#agentInput");
  sendBtn = panel.querySelector("#agentSendBtn");
  clearBtn = panel.querySelector("#agentClearBtn");
}

function _bindEvents() {
  toggleBtn.addEventListener("click", _togglePanel);
  panel.querySelector("#agentCloseBtn").addEventListener("click", _closePanel);
  panel.querySelector("#agentExpandBtn").addEventListener("click", _toggleExpand);
  clearBtn.addEventListener("click", _clearHistory);
  sendBtn.addEventListener("click", _sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  面板显隐
// ─────────────────────────────────────────────────────────────────────────────

function _togglePanel() {
  const open = panel.classList.toggle("agent-panel-open");
  toggleBtn.classList.toggle("active", open);
  if (open && chatLog.children.length === 0) {
    _appendAssistantBubble("你好！我是 AI 剧情助手。你可以让我帮你修改场景、优化台词、建议分支走向。");
  }
  if (open) inputEl.focus();
}

function _closePanel() {
  panel.classList.remove("agent-panel-open");
  toggleBtn.classList.remove("active");
  // 关闭面板时同时退出放大模式
  if (isExpanded) {
    isExpanded = false;
    panel.classList.remove("agent-panel-expanded");
    document.body.classList.remove("agent-expanded");
    panel.querySelector("#agentExpandBtn").textContent = "⤢";
  }
}

function _toggleExpand() {
  isExpanded = !isExpanded;
  panel.classList.toggle("agent-panel-expanded", isExpanded);
  document.body.classList.toggle("agent-expanded", isExpanded);
  panel.querySelector("#agentExpandBtn").textContent = isExpanded ? "⤡" : "⤢";
}

// ─────────────────────────────────────────────────────────────────────────────
//  对话主流程
// ─────────────────────────────────────────────────────────────────────────────

function _clearHistory() {
  agentHistory.length = 0;
  pendingPatches = [];
  chatLog.innerHTML = "";
  _appendAssistantBubble("对话已清空，可以重新开始。");
}

async function _sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = "";
  _setLoading(true);

  _appendUserBubble(text);
  agentHistory.push({ role: "user", content: text });

  const projectSnap = _buildProjectSnapshot();
  const settings = providerSettings();

  const body = {
    message: text,
    history: agentHistory.slice(-20),
    project: projectSnap,
    text_base_url: settings.textBaseUrl,
    text_api_key: settings.textApiKey,
    model: settings.textModel,
  };

  // ── 创建助手气泡容器 ──────────────────────────────────────────────────────
  // 布局：[tool 区域（上）] [思考折叠（上）] [文本内容（下）]
  const bubble = _createAssistantBubble();
  const toolsZone  = bubble.querySelector(".agent-tools-zone");   // tool 调用标签区域
  const thinkZone  = bubble.querySelector(".agent-think-zone");   // 思考过程折叠区
  const thinkBody  = bubble.querySelector(".agent-think-body");   // 思考正文
  const contentEl  = bubble.querySelector(".agent-msg-text");     // 正文 Markdown 区

  let assistantText = "";       // 积累正式回复（去除 <think> 后）
  let thinkText = "";           // 积累思考内容
  let insideThink = false;      // 当前是否在 <think> 块内
  let rawFull = "";             // 完整原始文本（用于解析 think 块）
  let errorOccurred = false;

  const flushContent = () => {
    // 渲染 Markdown（过滤掉 <think> 块后）
    contentEl.innerHTML = _renderMarkdown(assistantText);
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  const flushThink = () => {
    thinkBody.innerHTML = _renderMarkdown(thinkText);
    if (thinkText.trim()) {
      thinkZone.style.display = "";
    }
  };

  try {
    const resp = await fetch("/api/agent-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `请求失败 (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.type === "text") {
          rawFull += evt.text;
          // 实时解析 <think> 块
          const parsed = _parseThink(rawFull);
          assistantText = parsed.content;
          thinkText     = parsed.think;
          insideThink   = parsed.insideThink;
          flushContent();
          flushThink();

        } else if (evt.type === "tool_use") {
          _appendToolTag(toolsZone, evt.name, evt.args);

        } else if (evt.type === "tool_result") {
          if (evt.name === "update_scene" && !evt.is_error) {
            _handleUpdateSceneResult(evt.output, bubble);
          }

        } else if (evt.type === "done") {
          break outer;

        } else if (evt.type === "error") {
          errorOccurred = true;
          _appendErrorBubble(evt.message);
          break outer;
        }
      }
    }
  } catch (e) {
    errorOccurred = true;
    bubble.remove();
    _appendErrorBubble(String(e));
  }

  if (!errorOccurred && assistantText) {
    agentHistory.push({ role: "assistant", content: assistantText });
  }

  _setLoading(false);
  inputEl.focus();
}

// ─────────────────────────────────────────────────────────────────────────────
//  <think> 解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从原始文本中剥离 <think>...</think> 块。
 * 返回：{ think: string, content: string, insideThink: bool }
 * 支持流式（think 块未关闭时 insideThink=true，content 为空）。
 */
function _parseThink(raw) {
  const openTag  = "<think>";
  const closeTag = "</think>";
  const segments = [];
  let thinkParts = [];
  let pos = 0;
  let insideThink = false;

  while (pos < raw.length) {
    if (!insideThink) {
      const tStart = raw.indexOf(openTag, pos);
      if (tStart === -1) {
        segments.push(raw.slice(pos));
        break;
      }
      if (tStart > pos) segments.push(raw.slice(pos, tStart));
      insideThink = true;
      pos = tStart + openTag.length;
    } else {
      const tEnd = raw.indexOf(closeTag, pos);
      if (tEnd === -1) {
        // think 块还没关闭（流式中）
        thinkParts.push(raw.slice(pos));
        pos = raw.length;
        break;
      }
      thinkParts.push(raw.slice(pos, tEnd));
      insideThink = false;
      pos = tEnd + closeTag.length;
    }
  }

  return {
    think: thinkParts.join("").trim(),
    content: segments.join("").trim(),
    insideThink,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  极简 Markdown 渲染（不引入外部库）
// ─────────────────────────────────────────────────────────────────────────────

function _renderMarkdown(text) {
  if (!text) return "";

  // 先提取代码块，避免后续规则污染代码内容
  const codeBlocks = [];
  let html = text.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="agent-code-block"><code>${_escHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // 转义普通文本中的 HTML 特殊字符
  html = _escHtml(html);

  // 行内代码（转义后恢复）
  html = html.replace(/`([^`]+)`/g, `<code class="agent-code-inline">$1</code>`);

  // ── 表格 ──────────────────────────────────────────────────────────────────
  // 匹配 | col | col | 格式（含分隔行 |---|---|）
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split("\n").filter(r => r.trim());
    if (rows.length < 2) return tableBlock;
    const isSepRow = r => /^\|[\s|:-]+\|$/.test(r.trim());
    let thead = "", tbody = "";
    let headerDone = false;
    for (const row of rows) {
      if (isSepRow(row)) { headerDone = true; continue; }
      const cells = row.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      if (!headerDone) {
        thead += `<tr>${cells.map(c => `<th>${c}</th>`).join("")}</tr>`;
        headerDone = true; // header 后紧接分隔行，先标记
      } else {
        tbody += `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
      }
    }
    return `<table class="agent-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  // 标题（在段落处理之前）
  html = html.replace(/^### (.+)$/gm, `<h4 class="agent-h">$1</h4>`);
  html = html.replace(/^## (.+)$/gm,  `<h3 class="agent-h">$1</h3>`);
  html = html.replace(/^# (.+)$/gm,   `<h2 class="agent-h">$1</h2>`);

  // 粗体 / 斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, `<strong><em>$1</em></strong>`);
  html = html.replace(/\*\*(.+?)\*\*/g,     `<strong>$1</strong>`);
  html = html.replace(/\*(.+?)\*/g,         `<em>$1</em>`);

  // 无序列表（连续 li 包裹成 ul）
  html = html.replace(/^(?:[-*]) (.+)$/gm, `<li>$1</li>`);
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // 有序列表
  html = html.replace(/^\d+\. (.+)$/gm, `<_oli_>$1</_oli_>`);
  html = html.replace(/(<_oli_>.*<\/_oli_>\n?)+/g, m => `<ol>${m.replace(/<\/?_oli_>/g, t => t.includes("/") ? "</li>" : "<li>")}</ol>`);

  // 水平线
  html = html.replace(/^---+$/gm, `<hr class="agent-hr">`);

  // 段落：双换行分段
  html = html
    .split(/\n{2,}/)
    .map(block => {
      const t = block.trim();
      if (!t) return "";
      // 已是块级元素，不再包 p
      if (/^<(h[1-6]|ul|ol|pre|table|hr|blockquote)/.test(t)) return t;
      return `<p class="agent-p">${t.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  // 还原代码块
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return html;
}

function _escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─────────────────────────────────────────────────────────────────────────────
//  update_scene 应用逻辑
// ─────────────────────────────────────────────────────────────────────────────

function _handleUpdateSceneResult(outputStr, bubble) {
  let result;
  try { result = JSON.parse(outputStr); } catch { return; }
  const { scene_id, patch, updated_scene, reason } = result;
  if (!scene_id || !patch || !updated_scene) return;

  const patchId = `patch-${Date.now()}`;
  pendingPatches.push({ id: patchId, scene_id, patch, updated_scene });

  const applyBtn = document.createElement("button");
  applyBtn.className = "button primary agent-apply-btn";
  applyBtn.textContent = `✓ 应用修改：${Object.keys(patch).join("、")}`;
  applyBtn.title = reason || "";
  applyBtn.dataset.patchId = patchId;
  applyBtn.addEventListener("click", () => {
    const idx = pendingPatches.findIndex(p => p.id === patchId);
    if (idx === -1) return;
    const { scene_id: sid, updated_scene: updated } = pendingPatches[idx];
    _applyScenePatch(sid, updated);
    pendingPatches.splice(idx, 1);
    applyBtn.disabled = true;
    applyBtn.textContent = "✓ 已应用";
  });

  bubble.querySelector(".agent-patch-zone").appendChild(applyBtn);
}

function _applyScenePatch(sceneId, updatedScene) {
  const scenes = project?.interactive?.scenes || [];
  const idx = scenes.findIndex(s => s.id === sceneId);
  if (idx !== -1) { Object.assign(scenes[idx], updatedScene); render(); showToast("场景已更新"); return; }
  for (const ep of project?.episodes || []) {
    const epIdx = (ep.scenes || []).findIndex(s => s.id === sceneId);
    if (epIdx !== -1) { Object.assign(ep.scenes[epIdx], updatedScene); render(); showToast("场景已更新"); return; }
  }
  showToast("找不到目标场景，应用失败", "error");
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOM 构建辅助
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 创建助手气泡 DOM，内部结构：
 *   .agent-msg
 *     .agent-tools-zone      ← tool 调用标签（最上方）
 *     .agent-think-zone      ← <think> 折叠块
 *       summary
 *       .agent-think-body
 *     .agent-msg-text        ← 正式回复（Markdown 渲染）
 *     .agent-patch-zone      ← update_scene 应用按钮
 */
function _createAssistantBubble() {
  const wrap = document.createElement("div");
  wrap.className = "agent-msg agent-msg-assistant";

  wrap.innerHTML = `
    <div class="agent-tools-zone"></div>
    <details class="agent-think-zone" style="display:none">
      <summary class="agent-think-summary">思考过程</summary>
      <div class="agent-think-body"></div>
    </details>
    <div class="agent-msg-text"></div>
    <div class="agent-patch-zone"></div>
  `;
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return wrap;
}

function _appendUserBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "agent-msg agent-msg-user";
  const span = document.createElement("span");
  span.className = "agent-msg-text";
  span.textContent = text;
  wrap.appendChild(span);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/** 追加纯文本助手气泡（欢迎语 / 清空提示）*/
function _appendAssistantBubble(text) {
  const wrap = _createAssistantBubble();
  wrap.querySelector(".agent-msg-text").innerHTML = _renderMarkdown(text);
  return wrap;
}

function _appendErrorBubble(message) {
  const wrap = document.createElement("div");
  wrap.className = "agent-msg agent-msg-error";
  const span = document.createElement("span");
  span.className = "agent-msg-text";
  span.textContent = message;
  wrap.appendChild(span);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/**
 * 在 toolsZone 中追加 tool 调用标签（显示在回复上方）。
 */
function _appendToolTag(zone, toolName, args) {
  const tag = document.createElement("span");
  tag.className = "agent-tool-tag";
  const argsStr = JSON.stringify(args || {});
  tag.textContent = `🔧 ${toolName}(${argsStr.length > 60 ? argsStr.slice(0, 60) + "…" : argsStr})`;
  zone.appendChild(tag);
}

function _setLoading(loading) {
  sendBtn.disabled = loading;
  inputEl.disabled = loading;
  sendBtn.textContent = loading ? "…" : "发送";
}

// ─────────────────────────────────────────────────────────────────────────────
//  上下文序列化
// ─────────────────────────────────────────────────────────────────────────────

function _buildProjectSnapshot() {
  if (!project) return {};
  const meta = project.meta || {};

  // 选取当前模式下的场景集合和容器
  const container =
    meta.mode === "interactive"
      ? project.interactive
      : (project.episodes?.find(e => e.id === project.selectedEpisodeId) || null);

  const allScenes = container?.scenes || [];
  const startSceneId = container?.startSceneId || allScenes[0]?.id || "";

  const snap = {
    title:     meta.title     || "",
    synopsis:  meta.synopsis  || "",
    genre:     meta.genre     || "",
    style:     meta.visualStyle || "",
    character: meta.character || "",
    mode:      meta.mode || "interactive",
    startSceneId,
    scenes: allScenes.slice(0, 40).map(s => ({
      id:          s.id,
      isStart:     s.id === startSceneId,
      title:       s.title       || "",
      shot:        s.shot        || "",
      action:      s.action      || "",
      dialogue:    s.dialogue    || "",
      transition:  s.transition  || "",
      entryState:  s.entryState  || "",
      exitState:   s.exitState   || "",
      imagePrompt: s.imagePrompt || "",
      videoPrompt: s.videoPrompt || "",
      // 互动影游：nextSceneId 为线性后继，choices[].targetSceneId 为分支跳转
      nextSceneId: s.nextSceneId || "",
      choices: (s.choices || []).map(c => ({
        id:            c.id || "",
        text:          c.text || "",
        targetSceneId: c.targetSceneId || "",
        effect:        c.effect || "",
      })),
    })),
  };

  return snap;
}
