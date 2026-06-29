import {
  $, elements, DEFAULT_MODELS, STORAGE_KEY, RECOVERY_KEY, SECRET_STORAGE_KEY,
  currentMode, setCurrentMode, project, setProject,
} from "./state.js";
import {
  uid, choiceUid, showToast, stripEpisodePlanningContext,
} from "./utils.js";
import { composeVideoPrompt, mergeVideoNarrativeContext } from "./prompt.js";
import { rebuildSerialTransitions } from "./prompt.js";
import { render, renderEditor, renderCharacterPanel, renderSceneCardPanel } from "./render.js";
import { setMode } from "./mode.js";
import { providerSettings as _providerSettingsFromConfig } from "./provider-config.js";

// ─────────────────────────────────────────────
//  角色卡（结构化角色设定）
//  把旧的 meta.character 自由文本升级为 meta.characters 角色卡数组，
//  每张卡含年龄/性别/发型/服装/道具/情绪/表演等独立字段，
//  供提示词按出场角色精准注入，实现跨镜头角色连续性。
//  保留 meta.character 兼容字段（第一张卡的文本），旧逻辑无需改动。
// ─────────────────────────────────────────────
export function normalizeCharacterCard(partial = {}) {
  return {
    id: partial.id || uid(),
    name: String(partial.name || "").slice(0, 60) || "未命名角色",
    ageRange: String(partial.ageRange || "").slice(0, 40),
    gender: String(partial.gender || "").slice(0, 40),
    hair: String(partial.hair || "").slice(0, 80),
    outfit: String(partial.outfit || "").slice(0, 200),
    props: String(partial.props || "").slice(0, 200),
    emotion: String(partial.emotion || "").slice(0, 80),
    performance: String(partial.performance || "").slice(0, 80),
    notes: String(partial.notes || "").slice(0, 1000),
    imageUrl: String(partial.imageUrl || "").slice(0, 2000),
    imageStatus: ["idle", "working", "completed", "failed", "paused"].includes(partial.imageStatus) ? partial.imageStatus : "idle",
    imagePredictionId: String(partial.imagePredictionId || "").slice(0, 200),
  };
}

// 从旧的自由文本（如"林默，28岁亚洲女性领航员，黑色短发…"）解析为一张角色卡
export function characterCardFromText(text) {
  const raw = String(text || "").trim();
  const nameMatch = raw.match(/^([^，,、\s]{1,30})/);
  const name = nameMatch ? nameMatch[1] : "主角";
  // notes 保留原文去掉 name 前缀后的部分，避免 characterCardToText 重复拼接 name
  const rest = name ? raw.slice(name.length).replace(/^[，,、\s]+/, "") : raw;
  return normalizeCharacterCard({ name, notes: rest });
}

// 把角色卡拼回一段可读文本，用于兼容旧 meta.character 字段与提示词注入
export function characterCardToText(card) {
  if (!card) return "";
  return [
    card.name, card.ageRange, card.gender, card.hair,
    card.outfit, card.props, card.emotion, card.performance, card.notes,
  ].filter(Boolean).join("，");
}

// 规范化项目级角色卡集合：把旧 meta.character 迁移为 meta.characters 数组
export function normalizeCharacters(meta) {
  if (Array.isArray(meta.characters)) {
    meta.characters = meta.characters.map(normalizeCharacterCard);
  } else {
    const text = String(meta.character || "").trim();
    meta.characters = text ? [characterCardFromText(text)] : [];
  }
  // 保留 meta.character 兼容字段：取第一张角色卡的文本
  if (meta.characters.length) {
    meta.character = characterCardToText(meta.characters[0]);
  } else if (!("character" in meta)) {
    meta.character = "";
  }
}

// ─────────────────────────────────────────────
//  场景卡（结构化场景设定）
//  每张卡描述一个场景/地点的光照、氛围、环境细节，
//  供分镜按出场场景精准注入，实现跨镜头场景连续性。
//  可附带场景参考图，供文生图模型保持环境一致。
// ─────────────────────────────────────────────
export function normalizeSceneCard(partial = {}) {
  return {
    id: partial.id || uid(),
    name: String(partial.name || "").slice(0, 60) || "未命名场景",
    type: String(partial.type || "").slice(0, 40),
    lighting: String(partial.lighting || "").slice(0, 200),
    colorTone: String(partial.colorTone || "").slice(0, 80),
    atmosphere: String(partial.atmosphere || "").slice(0, 200),
    environment: String(partial.environment || "").slice(0, 500),
    timeOfDay: String(partial.timeOfDay || "").slice(0, 80),
    notes: String(partial.notes || "").slice(0, 1000),
    imageUrl: String(partial.imageUrl || "").slice(0, 2000),
    imageStatus: ["idle", "working", "completed", "failed", "paused"].includes(partial.imageStatus) ? partial.imageStatus : "idle",
    imagePredictionId: String(partial.imagePredictionId || "").slice(0, 200),
  };
}

export function normalizeSceneCards(meta) {
  if (Array.isArray(meta.sceneCards)) {
    meta.sceneCards = meta.sceneCards.map(normalizeSceneCard);
  } else {
    meta.sceneCards = [];
  }
}

// 自动关联：根据分镜文本中的角色名/场景名关键词，把角色卡和场景卡分配给分镜
export function autoAssociateCards(scenes, meta) {
  const characters = Array.isArray(meta?.characters) ? meta.characters : [];
  const sceneCards = Array.isArray(meta?.sceneCards) ? meta.sceneCards : [];
  if (!characters.length && !sceneCards.length) return;
  for (const scene of scenes) {
    // 角色关联：在 action / dialogue / title 中匹配角色名
    if (!Array.isArray(scene.characterIds) || !scene.characterIds.length) {
      const text = `${scene.action || ""} ${scene.dialogue || ""} ${scene.title || ""}`;
      const matched = characters.filter((c) => c.name && c.name !== "未命名角色" && text.includes(c.name));
      scene.characterIds = matched.length
        ? matched.map((c) => c.id)
        : (characters.length === 1 ? [characters[0].id] : []);
    }
    // 场景卡关联：在 action / title 中匹配场景卡名
    if (!scene.sceneCardId) {
      const text = `${scene.action || ""} ${scene.title || ""}`;
      const matched = sceneCards.find((c) => c.name && c.name !== "未命名场景" && text.includes(c.name));
      if (matched) {
        scene.sceneCardId = matched.id;
      } else if (sceneCards.length === 1) {
        scene.sceneCardId = sceneCards[0].id;
      }
    }
  }
}

// ─────────────────────────────────────────────
//  项目数据规范化
// ─────────────────────────────────────────────
export function normalizeProject(value) {
  const normalized = value && typeof value === "object" ? value : {};
  normalized.version = 6;
  normalized.meta = normalized.meta || readMetaFromForm();
  normalized.meta.treeDepth = Number(normalized.meta.treeDepth) || 3;
  normalized.meta.branchCount = Number(normalized.meta.branchCount) || 2;
  normalized.meta.interactiveShotsPerNode = Math.max(1, Math.min(5, Number(normalized.meta.interactiveShotsPerNode) || 1));
  normalized.meta.episodeCount = Number(normalized.meta.episodeCount) || 5;
  normalized.meta.shotsPerEpisode = Number(normalized.meta.shotsPerEpisode) || 5;
  normalized.meta.serialTone = normalized.meta.serialTone || "drama";
  normalized.meta.mode = normalized.meta.mode || "interactive";
  normalizeCharacters(normalized.meta);
  normalizeSceneCards(normalized.meta);
  // 供应商字段从 meta 中移除（已迁移到 provider-config），清理旧格式残留
  const _providerFields = [
    "textBaseUrl", "textModel", "textApiKey",
    "imageBaseUrl", "imageModel", "imageEditModel", "imageApiKey", "imageProvider",
    "videoBaseUrl", "videoModel", "videoApiKey", "videoProvider",
  ];
  _providerFields.forEach((f) => delete normalized.meta[f]);
  window.FrameForgeEpisodeModel.migrate(normalized);
  normalizeSceneCollection(normalized.interactive, false);
  normalized.episodes.forEach((episode) => normalizeSceneCollection(episode, true));
  window.FrameForgeEpisodeModel.normalizeEpisodes(normalized);
  return normalized;
}

export function normalizeSceneCollection(container, serial) {
  container.scenes = Array.isArray(container.scenes) ? container.scenes : [];
  container.scenes.forEach((scene, index) => {
    scene.order = Number.isFinite(Number(scene.order)) ? Number(scene.order) : index;
    scene.choices = Array.isArray(scene.choices) ? scene.choices.map((choice) => ({
      id: choice.id || choiceUid(), text: choice.text || "未命名选择",
      effect: choice.effect || "", targetSceneId: choice.targetSceneId || "",
    })) : [];
    if (!("nextSceneId" in scene)) scene.nextSceneId = container.scenes[index + 1]?.id || "";
    scene.episode = scene.episode || 1;
    scene.episodeOrder = Number.isFinite(Number(scene.episodeOrder)) ? Number(scene.episodeOrder) : (index + 1);
  });
  container.scenes.sort((left, right) => left.order - right.order);
  container.scenes.forEach((scene, index) => { scene.order = index; if (serial) scene.episodeOrder = index + 1; });
  container.startSceneId = container.startSceneId || container.scenes[0]?.id || null;
  container.scenes.forEach((scene, index) => {
    if (!("referenceSceneId" in scene)) {
      scene.referenceSceneId = scene.id === container.startSceneId ? "" : (container.startSceneId || "");
    }
    scene.imagePredictionId = scene.imagePredictionId || "";
    scene.videoPredictionId = scene.videoPredictionId || "";
    scene.imagePath = scene.imagePath || "";
    scene.videoPath = scene.videoPath || "";
    scene.transition = ["match", "dissolve", "cut", "fade"].includes(scene.transition) ? scene.transition : (index ? "match" : "cut");
    scene.entryState = scene.entryState || "";
    scene.exitState = scene.exitState || "";
    scene.characterIds = Array.isArray(scene.characterIds) ? scene.characterIds : [];
    scene.sceneCardId = scene.sceneCardId || "";
    scene.imagePrompt = stripEpisodePlanningContext(scene.imagePrompt || "");
    scene.videoPrompt = mergeVideoNarrativeContext(scene.videoPrompt || "", scene);
    if (scene.imageStatus === "working") scene.imageStatus = scene.imagePredictionId ? "paused" : "failed";
    if (scene.videoStatus === "working") scene.videoStatus = scene.videoPredictionId ? "paused" : "failed";
  });
  container.selectedSceneId = container.scenes.some((scene) => scene.id === container.selectedSceneId)
    ? container.selectedSceneId
    : container.startSceneId;
}

// ─────────────────────────────────────────────
//  表单 ↔ 项目元数据
// ─────────────────────────────────────────────
export function readMetaFromForm() {
  return {
    title: $("#projectTitle")?.value || "未命名项目",
    synopsis: $("#projectSynopsis")?.value || "",
    genre: $("#projectGenre")?.value || "科幻悬疑",
    aspectRatio: $("#projectAspect")?.value || "16:9",
    visualStyle: $("#projectStyle")?.value || "",
    character: $("#projectCharacter")?.value || "",
    characters: readCharactersFromForm(),
    sceneCards: readSceneCardsFromForm(),
    treeDepth: Number($("#projectTreeDepth")?.value || 3),
    branchCount: Number($("#projectBranchCount")?.value || 2),
    interactiveShotsPerNode: Math.max(1, Math.min(5, Number($("#projectInteractiveShotsPerNode")?.value || 1))),
    episodeCount: Number($("#projectEpisodeCount")?.value || 5),
    shotsPerEpisode: Number($("#projectShotsPerEpisode")?.value || 12),
    serialTone: $("#projectSerialTone")?.value || "drama",
    mode: currentMode,
    // 注意：供应商配置（BaseURL / Model / ApiKey）不再存入 project.meta，
    // 改由 provider-config.js 独立持久化。
  };
}

// 从角色卡面板读取结构化角色卡数组（与 #projectCharacter 隐藏字段并行存在）
export function readCharactersFromForm() {
  const overviewOpen = document.body.classList.contains("overview-open");
  const panel = overviewOpen ? $("#overviewCharacterPanel") : $("#characterPanel");
  if (!panel) return [];
  const existing = Array.isArray(project.meta?.characters) ? project.meta.characters : [];
  const cards = [];
  panel.querySelectorAll(".character-card").forEach((cardEl) => {
    const id = cardEl.dataset.charId || uid();
    const fields = {};
    cardEl.querySelectorAll(".char-field").forEach((input) => {
      fields[input.dataset.field] = input.value;
    });
    const prev = existing.find((c) => c.id === id);
    cards.push(normalizeCharacterCard({ id, ...fields, imageUrl: prev?.imageUrl || "", imageStatus: prev?.imageStatus, imagePredictionId: prev?.imagePredictionId || "" }));
  });
  return cards;
}

// 从场景卡面板读取结构化场景卡数组
export function readSceneCardsFromForm() {
  const overviewOpen = document.body.classList.contains("overview-open");
  const panel = overviewOpen ? $("#overviewSceneCardPanel") : $("#sceneCardPanel");
  if (!panel) return [];
  const existing = Array.isArray(project.meta?.sceneCards) ? project.meta.sceneCards : [];
  const cards = [];
  panel.querySelectorAll(".scene-card").forEach((cardEl) => {
    const id = cardEl.dataset.sceneId || uid();
    const fields = {};
    cardEl.querySelectorAll(".scene-field").forEach((input) => {
      fields[input.dataset.field] = input.value;
    });
    const prev = existing.find((c) => c.id === id);
    cards.push(normalizeSceneCard({ id, ...fields, imageUrl: prev?.imageUrl || "", imageStatus: prev?.imageStatus, imagePredictionId: prev?.imagePredictionId || "" }));
  });
  return cards;
}

export function applyMetaToForm() {
  elements.projectTitle.value = project.meta.title;
  elements.projectSynopsis.value = project.meta.synopsis;
  elements.projectGenre.value = project.meta.genre;
  elements.projectAspect.value = project.meta.aspectRatio;
  elements.projectStyle.value = project.meta.visualStyle;
  elements.projectCharacter.value = project.meta.character;
  renderCharacterPanel();
  renderSceneCardPanel();
  elements.projectTreeDepth.value = String(project.meta.treeDepth || 3);
  elements.projectBranchCount.value = String(project.meta.branchCount || 2);
  if (elements.projectInteractiveShotsPerNode) elements.projectInteractiveShotsPerNode.value = String(project.meta.interactiveShotsPerNode || 1);
  $("#projectEpisodeCount").value = String(project.meta.episodeCount || 5);
  $("#projectShotsPerEpisode").value = String(project.meta.shotsPerEpisode || 5);
  $("#projectSerialTone").value = project.meta.serialTone || "drama";
  // 供应商设置表单由 provider-config.js 的 loadProviderConfig() 负责填充，此处不再处理。
  setCurrentMode(project.meta.mode || "interactive");
  setMode(currentMode);
}

// ─────────────────────────────────────────────
//  供应商密钥（已迁移至 provider-config.js）
//  保留这些 export 以兼容仍在使用的其他模块调用处，
//  但实际读写已由 provider-config.js 接管。
// ─────────────────────────────────────────────
export function loadProviderSecrets() {
  try { return JSON.parse(sessionStorage.getItem(SECRET_STORAGE_KEY)) || {}; }
  catch { return {}; }
}
export function applyProviderSecrets() {
  // no-op：由 provider-config.js 的 loadProviderConfig() 负责
}
export function saveProviderSecrets() {
  // no-op：由 provider-config.js 的 saveProviderConfig() 负责
}
/** 读取当前供应商配置，代理到 provider-config.js */
export function providerSettings(kind) {
  return _providerSettingsFromConfig(kind);
}

// ─────────────────────────────────────────────
//  本地持久化与撤销快照
// ─────────────────────────────────────────────
export function saveProject() {
  project.meta = readMetaFromForm();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}
export function loadProject() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
  catch { return null; }
}
export function snapshotProjectBeforeReplacement(reason) {
  localStorage.setItem(RECOVERY_KEY, JSON.stringify({ project, reason, createdAt: new Date().toISOString() }));
  updateRecoveryButton();
}
export function updateRecoveryButton() {
  const button = $("#restoreProjectBtn");
  if (button) button.hidden = !localStorage.getItem(RECOVERY_KEY);
}
export function restoreProjectSnapshot() {
  try {
    const recovery = JSON.parse(localStorage.getItem(RECOVERY_KEY));
    if (!recovery?.project) throw new Error("没有可恢复的项目快照。");
    const current = project;
    setProject(normalizeProject(recovery.project));
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ project: current, reason: "恢复前状态", createdAt: new Date().toISOString() }));
    applyMetaToForm(); saveProject(); render(); updateRecoveryButton();
    showToast(`已恢复覆盖前项目${recovery.reason ? `（${recovery.reason}）` : ""}。`);
  } catch (error) { showToast(error.message, true); }
}

// ─────────────────────────────────────────────
//  分集与场景访问辅助
// ─────────────────────────────────────────────
export function activeEpisode() {
  return window.FrameForgeEpisodeModel.active(project);
}
export function serialSceneEntries() {
  return [...project.episodes].sort((left, right) => left.order - right.order).flatMap((episode, episodeIndex) =>
    [...episode.scenes].sort((left, right) => left.order - right.order).map((scene, sceneIndex) => ({
      scene, episode, episodeNumber: episodeIndex + 1, sceneNumber: sceneIndex + 1,
    })),
  );
}
export function findSceneAcrossProject(sceneId) {
  if (!sceneId) return null;
  if (currentMode === "serial") return serialSceneEntries().find((entry) => entry.scene.id === sceneId)?.scene || null;
  return project.interactive.scenes.find((scene) => scene.id === sceneId) || null;
}
export function firstEpisodeMasterScene() {
  const firstEpisode = [...project.episodes].sort((left, right) => left.order - right.order)[0];
  if (!firstEpisode) return null;
  return [...firstEpisode.scenes].sort((left, right) => left.order - right.order)[0] || null;
}
export function ensureAtLeastOneEpisode() {
  if (project.episodes.length) return activeEpisode();
  const episode = window.FrameForgeEpisodeModel.create(0, { shotCount: project.meta.shotsPerEpisode || 5 });
  project.episodes.push(episode);
  project.selectedEpisodeId = episode.id;
  return episode;
}

export function selectedScene() {
  return project.scenes.find((scene) => scene.id === project.selectedSceneId);
}
export function orderedScenes() {
  return [...project.scenes].sort((left, right) => left.order - right.order);
}
export function normalizeSceneOrder() {
  project.scenes = orderedScenes();
  project.scenes.forEach((scene, index) => {
    scene.order = index;
    if (currentMode === "serial") {
      scene.episode = (activeEpisode()?.order || 0) + 1;
      scene.episodeOrder = index + 1;
    }
  });
}
export function moveSceneRelative(draggedId, targetId, placeAfter = false) {
  if (!draggedId || draggedId === targetId) return false;
  const scenes = orderedScenes();
  const fromIndex = scenes.findIndex((scene) => scene.id === draggedId);
  const targetIndex = scenes.findIndex((scene) => scene.id === targetId);
  if (fromIndex < 0 || targetIndex < 0) return false;
  const [moved] = scenes.splice(fromIndex, 1);
  const targetAfterRemoval = scenes.findIndex((scene) => scene.id === targetId);
  scenes.splice(targetAfterRemoval + (placeAfter ? 1 : 0), 0, moved);
  project.scenes = scenes;
  normalizeSceneOrder();
  if (currentMode === "serial") rebuildSerialTransitions(false, true);
  saveProject();
  return true;
}

export function createScene(partial = {}) {
  return {
    id: uid(), title: "新镜头", shot: "中景", duration: 8,
    action: "", dialogue: "", imagePrompt: "", videoPrompt: "",
    imageUrl: "", videoUrl: "", imageLocalUrl: "", videoLocalUrl: "",
    imageStatus: "idle", videoStatus: "idle",
    imagePredictionId: "", videoPredictionId: "",
    nextSceneId: "", choices: [], referenceSceneId: "",
    transition: "match", entryState: "", exitState: "",
    characterIds: [],
    sceneCardId: "",
    order: project?.scenes?.length || 0,
    episode: 1, episodeOrder: (project?.scenes?.length || 0) + 1,
    ...partial,
  };
}
