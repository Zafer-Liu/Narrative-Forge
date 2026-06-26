/**
 * 供应商配置持久化（本地模式 / Railway 环境变量）
 *
 * 职责：
 *  - 启动时 GET /api/provider-config，将 BaseURL / ModelID / ApiKey 填入表单
 *  - 用户修改表单后 POST /api/provider-config 保存
 *  - 若字段来自服务器环境变量（_envKeys），显示「已由服务器配置」占位，禁用输入
 *  - 供应商设置不再随 project.meta 导出 / 导入
 */

import { elements, DEFAULT_MODELS } from "./state.js";
import { showToast } from "./utils.js";

const PROVIDER_CONFIG_LOCAL_KEY = "nf-provider-config-v1";

// 当前生效的配置（内存缓存，供 providerSettings() 读取）
let _config = {};
// 哪些字段来自服务器环境变量（前端禁用这些字段的输入）
let _envKeys = {};

// ─────────────────────────────────────────────────────────────────────────────
//  启动加载
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 应用启动时调用一次。
 * 优先从后端拉取（支持环境变量），降级到 localStorage 缓存。
 */
export async function loadProviderConfig() {
  let remote = null;
  try {
    const resp = await fetch("/api/provider-config");
    if (resp.ok) {
      const body = await resp.json();
      remote = body.config || {};
      _envKeys = remote._envKeys || {};
    }
  } catch {
    /* 网络不通时降级 */
  }

  // 合并：远程 > localStorage 缓存 > 默认值
  const cached = _loadLocalCache();
  _config = { ...DEFAULT_MODELS, ...cached, ...(remote || {}) };
  delete _config._envKeys;

  _applyToForm();
}

/**
 * 将当前配置写入表单元素。
 */
function _applyToForm() {
  const el = elements;
  if (!el.projectTextBaseUrl) return; // DOM 未就绪

  _setField(el.projectTextBaseUrl,    _config.textBaseUrl    || DEFAULT_MODELS.textBaseUrl);
  _setField(el.projectTextModel,      _config.textModel      || DEFAULT_MODELS.textModel);
  _setField(el.projectImageBaseUrl,   _config.imageBaseUrl   || DEFAULT_MODELS.imageBaseUrl);
  _setField(el.projectImageModel,     _config.imageModel     || DEFAULT_MODELS.imageModel);
  if (el.projectImageEditModel)
    _setField(el.projectImageEditModel, _config.imageEditModel || DEFAULT_MODELS.imageEditModel);
  _setField(el.projectVideoBaseUrl,   _config.videoBaseUrl   || DEFAULT_MODELS.videoBaseUrl);
  _setField(el.projectVideoModel,     _config.videoModel     || DEFAULT_MODELS.videoModel);
  if (el.projectImageProvider)
    _setField(el.projectImageProvider, _config.imageProvider  || "atlascloud");
  if (el.projectVideoProvider)
    _setField(el.projectVideoProvider, _config.videoProvider  || "atlascloud");

  // API Key 字段：来自 env 时显示占位符并禁用
  _setApiKeyField(el.projectTextApiKey,  "textApiKey",  "TEXT_MODEL_API_KEY");
  _setApiKeyField(el.projectImageApiKey, "imageApiKey", "IMAGE_MODEL_API_KEY");
  _setApiKeyField(el.projectVideoApiKey, "videoApiKey", "VIDEO_MODEL_API_KEY");
}

function _setField(el, value) {
  if (!el) return;
  el.value = value;
  el.disabled = false;
  el.removeAttribute("placeholder");
}

function _setApiKeyField(el, field, envName) {
  if (!el) return;
  if (_envKeys[field]) {
    el.value = "";
    el.placeholder = `已由服务器环境变量配置 (${envName})`;
    el.disabled = true;
  } else {
    el.value = _config[field] || "";
    el.placeholder = "输入 API Key（仅保存在本机）";
    el.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  保存
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从表单读取供应商配置并持久化到后端（+本地缓存）。
 * 由「保存供应商设置」按钮或自动触发调用。
 */
export async function saveProviderConfig() {
  const cfg = _readFromForm();
  _config = { ..._config, ...cfg };

  // 本地缓存（降级备用）
  _saveLocalCache(cfg);

  // 后端持久化
  try {
    const resp = await fetch("/api/provider-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      showToast(`供应商设置保存失败：${body.error || resp.status}`, true);
      return false;
    }
    showToast("供应商设置已保存");
    return true;
  } catch {
    showToast("供应商设置已保存到本地缓存（后端不可达）");
    return true;
  }
}

/**
 * 读取当前生效的供应商配置（供 api.js / agent-panel.js 调用）。
 * kind: "text" | "image" | "video"（如果传了 kind，只返回该种配置）
 */
export function providerSettings(kind) {
  if (kind === "imageEdit") {
    return {
      baseUrl:  _config.imageBaseUrl  || "",
      apiKey:   _config.imageApiKey   || "",
      model:    _config.imageEditModel || _config.imageModel || "",
      provider: _config.imageProvider || "atlascloud",
    };
  }
  if (kind) {
    return {
      baseUrl:  _config[`${kind}BaseUrl`]  || "",
      apiKey:   _config[`${kind}ApiKey`]   || "",
      model:    _config[`${kind}Model`]    || "",
      provider: _config[`${kind}Provider`] || "atlascloud",
    };
  }
  return { ..._config };
}

// ─────────────────────────────────────────────────────────────────────────────
//  内部辅助
// ─────────────────────────────────────────────────────────────────────────────

function _readFromForm() {
  const el = elements;
  const cfg = {
    textBaseUrl:    el.projectTextBaseUrl?.value.trim().replace(/\/+$/, "") || "",
    textModel:      el.projectTextModel?.value.trim() || "",
    imageBaseUrl:   el.projectImageBaseUrl?.value.trim().replace(/\/+$/, "") || "",
    imageModel:     el.projectImageModel?.value.trim() || "",
    imageEditModel: el.projectImageEditModel?.value.trim() || "",
    videoBaseUrl:   el.projectVideoBaseUrl?.value.trim().replace(/\/+$/, "") || "",
    videoModel:     el.projectVideoModel?.value.trim() || "",
    imageProvider:  el.projectImageProvider?.value || "atlascloud",
    videoProvider:  el.projectVideoProvider?.value || "atlascloud",
  };
  // API Key：只在未被 env 禁用时才读取
  if (!_envKeys.textApiKey)  cfg.textApiKey  = el.projectTextApiKey?.value.trim()  || "";
  if (!_envKeys.imageApiKey) cfg.imageApiKey = el.projectImageApiKey?.value.trim() || "";
  if (!_envKeys.videoApiKey) cfg.videoApiKey = el.projectVideoApiKey?.value.trim() || "";
  return cfg;
}

function _loadLocalCache() {
  try { return JSON.parse(localStorage.getItem(PROVIDER_CONFIG_LOCAL_KEY)) || {}; }
  catch { return {}; }
}

function _saveLocalCache(cfg) {
  try { localStorage.setItem(PROVIDER_CONFIG_LOCAL_KEY, JSON.stringify(cfg)); }
  catch { /* 存储满或隐私模式 */ }
}
