import { $, elements, setToastTimer, toastTimer } from "./state.js";

// ─────────────────────────────────────────────
//  ID 生成
// ─────────────────────────────────────────────
export function uid() {
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
export function choiceUid() {
  return `choice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─────────────────────────────────────────────
//  通用 UI 工具
// ─────────────────────────────────────────────
export function toggleButton(selector, disabled, text) {
  const button = $(selector); button.disabled = disabled; button.textContent = text;
}

export function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${isError ? " error" : ""}`;
  setToastTimer(setTimeout(() => { elements.toast.className = "toast"; }, 5000));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

// ─────────────────────────────────────────────
//  叙事文本工具（纯函数）
// ─────────────────────────────────────────────
export function stripEpisodePlanningContext(prompt) {
  return String(prompt || "")
    .split("\n")
    .filter((line) => !/^\s*(本集设定|本集叙事|全剧梗概|本集梗概|叙事目标|结尾目标)[：:]/.test(line))
    .join("\n")
    .trim();
}

export function spokenCharacterCount(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

export function dialogueBudget(duration) {
  return Math.max(0, Math.floor((Number(duration) - 1.5) * 3));
}

export function recommendedDialogueDuration(dialogue) {
  const required = Math.ceil(spokenCharacterCount(dialogue) / 3 + 1.5);
  return [4, 6, 8, 10, 12, 15].find((duration) => duration >= required) || 15;
}

export function narrativeSentences(value) {
  return String(value || "").split(/(?<=[。！？!?；;])\s*/).map((item) => item.trim()).filter(Boolean);
}

export function atomicNarrativeBeat(value, fallback) {
  const sentence = narrativeSentences(value)[0] || fallback;
  return String(sentence || "").slice(0, 160);
}

export function transitionLabel(value) {
  return { match: "动作匹配", dissolve: "柔和淡变", cut: "直接切换", fade: "淡入淡出" }[value] || "动作匹配";
}

export function statusClass(status, url) {
  if (status === "working") return "working";
  if (status === "paused") return "paused";
  return url ? "done" : "";
}

export function estimatedTreeNodes(depth, branches) {
  return Array.from({ length: depth }, (_, level) => branches ** level).reduce((sum, value) => sum + value, 0);
}

export function imageSizeForAspect(aspect) {
  if (aspect === "9:16") return "1024x1536";
  if (aspect === "1:1") return "1024x1024";
  return "1536x1024";
}

// ─────────────────────────────────────────────
//  JSON 解析（文本模型返回）
// ─────────────────────────────────────────────
export function extractAssistantContent(result) {
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").join("");
  throw new Error("文本模型没有返回可读取的剧情内容。");
}

export function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return text;
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") { depth -= 1; if (depth === 0) return text.slice(start, index + 1); }
  }
  return text.slice(start);
}

export function parseStoryJson(result) {
  const raw = extractAssistantContent(result)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonText = extractFirstJsonObject(raw);
  try { return JSON.parse(jsonText); }
  catch { throw new Error("文本模型返回的剧情不是有效 JSON，请重试或更换文本模型。"); }
}

// ─────────────────────────────────────────────
//  文本生成错误格式化
// ─────────────────────────────────────────────
export function formatTextGenError(error) {
  const kind = error.errorKind || "";
  const reason = error.reason || "";
  const base = error.message || "生成失败";
  const hint = " 可改用\"本地模板生成\"。";
  if (reason === "not_found") return `${base}\n建议：检查模型 ID 是否正确。AtlasCloud 可用模型：deepseek-ai/DeepSeek-V3-0324、deepseek-ai/DeepSeek-V3.1 等。${hint}`;
  if (reason === "auth_failed") return `${base}\n建议：检查 API Key 是否正确。${hint}`;
  if (reason === "forbidden") return `${base}\n建议：检查 API Key 是否有该模型的访问权限。${hint}`;
  if (reason === "credits_exhausted") return `${base}\n建议：充值或更换供应商。${hint}`;
  if (kind === "timeout") return `${base}\n建议：降低剧情树深度/分支数，或更换响应更快的模型。${hint}`;
  if (kind === "dns_failure") return `${base}\n建议：检查网络连接、DNS 或代理设置。${hint}`;
  if (kind === "connection_refused") return `${base}\n建议：检查 API 根地址是否正确。${hint}`;
  if (kind === "ssl_error") return `${base}\n建议：检查系统时间是否正确、代理是否拦截了 HTTPS。${hint}`;
  if (kind === "proxy_error") return `${base}\n建议：关闭或更换代理/VPN 后重试。${hint}`;
  if (kind === "connection_reset") return `${base}\n建议：检查 API Key、代理/VPN 或更换供应商。${hint}`;
  return `${base}${hint}`;
}
