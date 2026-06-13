const STORAGE_KEY = "frameforge-project-v1";
const SECRET_STORAGE_KEY = "frameforge-provider-secrets-v1";
const DEFAULT_MODELS = {
  textBaseUrl: "https://api.atlascloud.ai/v1",
  textModel: "deepseek-v3",
  imageBaseUrl: "https://api.atlascloud.ai/api/v1/model",
  imageModel: "openai/gpt-image-2/text-to-image",
  imageEditModel: "openai/gpt-image-2/edit",
  videoBaseUrl: "https://api.atlascloud.ai/api/v1/model",
  videoModel: "xai/grok-imagine-video-v1.5/image-to-video",
};

// ─── 当前项目模式："interactive" | "serial"
let currentMode = "interactive";

const $ = (selector) => document.querySelector(selector);
const elements = {
  projectTitle: $("#projectTitle"), projectSynopsis: $("#projectSynopsis"),
  projectGenre: $("#projectGenre"), projectAspect: $("#projectAspect"),
  projectStyle: $("#projectStyle"), projectCharacter: $("#projectCharacter"),
  projectTreeDepth: $("#projectTreeDepth"), projectBranchCount: $("#projectBranchCount"),
  projectTextModel: $("#projectTextModel"), projectImageModel: $("#projectImageModel"),
  projectVideoModel: $("#projectVideoModel"), projectImageEditModel: $("#projectImageEditModel"),
  projectTextBaseUrl: $("#projectTextBaseUrl"), projectImageBaseUrl: $("#projectImageBaseUrl"),
  projectVideoBaseUrl: $("#projectVideoBaseUrl"), projectTextApiKey: $("#projectTextApiKey"),
  projectImageApiKey: $("#projectImageApiKey"), projectVideoApiKey: $("#projectVideoApiKey"),
  sceneList: $("#sceneList"), sceneEditor: $("#sceneEditor"), emptyState: $("#emptyState"),
  sceneTitle: $("#sceneTitle"), sceneShot: $("#sceneShot"), sceneDuration: $("#sceneDuration"),
  sceneAction: $("#sceneAction"), sceneDialogue: $("#sceneDialogue"),
  sceneTransition: $("#sceneTransition"), sceneEntryState: $("#sceneEntryState"), sceneExitState: $("#sceneExitState"),
  sceneNext: $("#sceneNext"), choiceList: $("#choiceList"),
  sceneReference: $("#sceneReference"), referenceStatus: $("#referenceStatus"),
  sceneImagePrompt: $("#sceneImagePrompt"), sceneVideoPrompt: $("#sceneVideoPrompt"),
  imageCard: $("#imageCard"), videoCard: $("#videoCard"), toast: $("#toast"),
  storyModal: $("#storyModal"), storyPlayer: $("#storyPlayer"), playerStage: $("#playerStage"),
  serialModal: $("#serialModal"), serialPlayer: $("#serialPlayer"), serialStage: $("#serialStage"),
  treeModal: $("#treeModal"), treeBrowser: $("#treeBrowser"), treeViewport: $("#treeViewport"),
  treeCanvas: $("#treeCanvas"), treeEdges: $("#treeEdges"), treeNodes: $("#treeNodes"),
  episodeList: $("#episodeList"), episodeTitle: $("#episodeTitle"),
  episodeSynopsis: $("#episodeSynopsis"), episodeObjective: $("#episodeObjective"),
  episodeHook: $("#episodeHook"), episodeEnding: $("#episodeEnding"),
  episodeShotCount: $("#episodeShotCount"), episodeSettings: $("#episodeSettings"),
  mediaPreviewModal: $("#mediaPreviewModal"), mediaPreviewStage: $("#mediaPreviewStage"),
};

let project = normalizeProject(loadProject() || {
  version: 6,
  meta: readMetaFromForm(),
  interactive: { scenes: [], selectedSceneId: null, startSceneId: null },
  episodes: [],
  selectedEpisodeId: null,
});
let toastTimer;
let playerState = { sceneId: null, history: [], startSceneId: null };
let serialState = { index: 0, autoPlay: false, autoTimer: null };
const activeTasks = new Map();
let treeZoom = 1;
let draggedSceneId = null;
let draggedSceneSource = "";
let draggedEpisodeId = null;
// 剧情树面板拖拽平移
let treePanState = { active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 };

// ─────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────
function uid() {
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function choiceUid() {
  return `choice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─────────────────────────────────────────────
//  模式切换
// ─────────────────────────────────────────────
function setMode(mode) {
  const appReady = document.body.dataset.appReady === "true";
  if (appReady && currentMode === "serial") syncEpisodeFromForm();
  if (appReady) syncEditorToScene();
  currentMode = mode;
  project.meta.mode = mode;
  if (mode === "serial") {
    ensureAtLeastOneEpisode();
    if (appReady) rebuildSerialTransitions(false, true);
  }
  saveProject();

  // 顶栏按钮
  document.querySelectorAll(".mode-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
  // 互动影游专属元素
  const isInteractive = mode === "interactive";
  document.querySelectorAll("[data-interactive-only]").forEach((el) => { el.hidden = !isInteractive; });
  document.querySelectorAll("[data-serial-only]").forEach((el) => { el.hidden = isInteractive; });

  // 面板显示
  $("#interactiveSettings").hidden = !isInteractive;
  $("#serialSettings").hidden = isInteractive;
  $("#interactiveListActions").hidden = !isInteractive;
  $("#serialListActions").hidden = isInteractive;
  $("#flowBlock").hidden = !isInteractive;
  $("#serialFlowBlock").hidden = isInteractive;

  // 品牌字幕
  $("#brandSubtitle").textContent = isInteractive ? "叙事锻造工坊" : "AI 短剧导演模式";
  $("#exportPlayerBtn").textContent = isInteractive ? "导出试玩包" : "导出当前集成片";

  // 剧情树图例
  $("#legendChoice").hidden = !isInteractive;
  $("#legendEnding").hidden = !isInteractive;
  $("#legendSerial").hidden = isInteractive;
  $("#legendInteractive").hidden = !isInteractive;

  // 生成按钮提示
  if (!isInteractive) {
    $("#draftBtn").textContent = "使用文本模型生成当前集";
    $("#localDraftBtn").textContent = "使用本地模板生成当前集";
    updateSerialEstimate();
  } else {
    $("#draftBtn").textContent = "使用文本模型生成";
    $("#localDraftBtn").textContent = "使用本地模板生成";
    updateTreeEstimate();
  }

  render();
}

// ─────────────────────────────────────────────
//  项目数据规范化
// ─────────────────────────────────────────────
function normalizeProject(value) {
  const normalized = value && typeof value === "object" ? value : {};
  normalized.version = 6;
  normalized.meta = normalized.meta || readMetaFromForm();
  normalized.meta.treeDepth = Number(normalized.meta.treeDepth) || 3;
  normalized.meta.branchCount = Number(normalized.meta.branchCount) || 2;
  normalized.meta.episodeCount = Number(normalized.meta.episodeCount) || 5;
  normalized.meta.shotsPerEpisode = Number(normalized.meta.shotsPerEpisode) || 5;
  normalized.meta.serialTone = normalized.meta.serialTone || "drama";
  normalized.meta.mode = normalized.meta.mode || "interactive";
  if (normalized.meta.textModel === "openai/gpt-5.4") normalized.meta.textModel = DEFAULT_MODELS.textModel;
  Object.entries(DEFAULT_MODELS).forEach(([key, value]) => { normalized.meta[key] = normalized.meta[key] || value; });
  window.FrameForgeEpisodeModel.migrate(normalized);
  normalizeSceneCollection(normalized.interactive, false);
  normalized.episodes.forEach((episode) => normalizeSceneCollection(episode, true));
  window.FrameForgeEpisodeModel.normalizeEpisodes(normalized);
  return normalized;
}

function normalizeSceneCollection(container, serial) {
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
    scene.transition = ["match", "dissolve", "cut", "fade"].includes(scene.transition) ? scene.transition : (index ? "match" : "cut");
    scene.entryState = scene.entryState || "";
    scene.exitState = scene.exitState || "";
    scene.imagePrompt = stripEpisodePlanningContext(scene.imagePrompt || "");
    scene.videoPrompt = mergeVideoNarrativeContext(scene.videoPrompt || "", scene);
    if (scene.imageStatus === "working") scene.imageStatus = scene.imagePredictionId ? "paused" : "failed";
    if (scene.videoStatus === "working") scene.videoStatus = scene.videoPredictionId ? "paused" : "failed";
  });
  container.selectedSceneId = container.scenes.some((scene) => scene.id === container.selectedSceneId)
    ? container.selectedSceneId
    : container.startSceneId;
}

function readMetaFromForm() {
  return {
    title: $("#projectTitle")?.value || "未命名项目",
    synopsis: $("#projectSynopsis")?.value || "",
    genre: $("#projectGenre")?.value || "科幻悬疑",
    aspectRatio: $("#projectAspect")?.value || "16:9",
    visualStyle: $("#projectStyle")?.value || "",
    character: $("#projectCharacter")?.value || "",
    treeDepth: Number($("#projectTreeDepth")?.value || 3),
    branchCount: Number($("#projectBranchCount")?.value || 2),
    episodeCount: Number($("#projectEpisodeCount")?.value || 5),
    shotsPerEpisode: Number($("#projectShotsPerEpisode")?.value || 12),
    serialTone: $("#projectSerialTone")?.value || "drama",
    mode: currentMode,
    textBaseUrl: $("#projectTextBaseUrl")?.value.trim().replace(/\/+$/, "") || DEFAULT_MODELS.textBaseUrl,
    textModel: $("#projectTextModel")?.value.trim() || DEFAULT_MODELS.textModel,
    imageBaseUrl: $("#projectImageBaseUrl")?.value.trim().replace(/\/+$/, "") || DEFAULT_MODELS.imageBaseUrl,
    imageModel: $("#projectImageModel")?.value.trim() || DEFAULT_MODELS.imageModel,
    imageEditModel: $("#projectImageEditModel")?.value.trim() || DEFAULT_MODELS.imageEditModel,
    videoBaseUrl: $("#projectVideoBaseUrl")?.value.trim().replace(/\/+$/, "") || DEFAULT_MODELS.videoBaseUrl,
    videoModel: $("#projectVideoModel")?.value.trim() || DEFAULT_MODELS.videoModel,
  };
}

function applyMetaToForm() {
  elements.projectTitle.value = project.meta.title;
  elements.projectSynopsis.value = project.meta.synopsis;
  elements.projectGenre.value = project.meta.genre;
  elements.projectAspect.value = project.meta.aspectRatio;
  elements.projectStyle.value = project.meta.visualStyle;
  elements.projectCharacter.value = project.meta.character;
  elements.projectTreeDepth.value = String(project.meta.treeDepth || 3);
  elements.projectBranchCount.value = String(project.meta.branchCount || 2);
  $("#projectEpisodeCount").value = String(project.meta.episodeCount || 5);
  $("#projectShotsPerEpisode").value = String(project.meta.shotsPerEpisode || 5);
  $("#projectSerialTone").value = project.meta.serialTone || "drama";
  elements.projectTextBaseUrl.value = project.meta.textBaseUrl || DEFAULT_MODELS.textBaseUrl;
  elements.projectTextModel.value = project.meta.textModel || DEFAULT_MODELS.textModel;
  elements.projectImageBaseUrl.value = project.meta.imageBaseUrl || DEFAULT_MODELS.imageBaseUrl;
  elements.projectImageModel.value = project.meta.imageModel || DEFAULT_MODELS.imageModel;
  elements.projectImageEditModel.value = project.meta.imageEditModel || DEFAULT_MODELS.imageEditModel;
  elements.projectVideoBaseUrl.value = project.meta.videoBaseUrl || DEFAULT_MODELS.videoBaseUrl;
  elements.projectVideoModel.value = project.meta.videoModel || DEFAULT_MODELS.videoModel;
  applyProviderSecrets();
  // 先应用模式再刷新估算
  currentMode = project.meta.mode || "interactive";
  setMode(currentMode);
}

function loadProviderSecrets() {
  try { return JSON.parse(sessionStorage.getItem(SECRET_STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function applyProviderSecrets() {
  const secrets = loadProviderSecrets();
  elements.projectTextApiKey.value = secrets.textApiKey || "";
  elements.projectImageApiKey.value = secrets.imageApiKey || "";
  elements.projectVideoApiKey.value = secrets.videoApiKey || "";
}
function saveProviderSecrets() {
  sessionStorage.setItem(SECRET_STORAGE_KEY, JSON.stringify({
    textApiKey: elements.projectTextApiKey.value.trim(),
    imageApiKey: elements.projectImageApiKey.value.trim(),
    videoApiKey: elements.projectVideoApiKey.value.trim(),
  }));
}
function providerSettings(kind) {
  const meta = readMetaFromForm();
  const secrets = loadProviderSecrets();
  return { baseUrl: meta[`${kind}BaseUrl`], apiKey: secrets[`${kind}ApiKey`] || "" };
}

function saveProject() {
  project.meta = readMetaFromForm();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}
function loadProject() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); }
  catch { return null; }
}
function activeEpisode() {
  return window.FrameForgeEpisodeModel.active(project);
}
function serialSceneEntries() {
  return [...project.episodes].sort((left, right) => left.order - right.order).flatMap((episode, episodeIndex) =>
    [...episode.scenes].sort((left, right) => left.order - right.order).map((scene, sceneIndex) => ({
      scene, episode, episodeNumber: episodeIndex + 1, sceneNumber: sceneIndex + 1,
    })),
  );
}
function findSceneAcrossProject(sceneId) {
  if (!sceneId) return null;
  if (currentMode === "serial") return serialSceneEntries().find((entry) => entry.scene.id === sceneId)?.scene || null;
  return project.interactive.scenes.find((scene) => scene.id === sceneId) || null;
}
function firstEpisodeMasterScene() {
  const firstEpisode = [...project.episodes].sort((left, right) => left.order - right.order)[0];
  if (!firstEpisode) return null;
  return [...firstEpisode.scenes].sort((left, right) => left.order - right.order)[0] || null;
}
function ensureAtLeastOneEpisode() {
  if (project.episodes.length) return activeEpisode();
  const episode = window.FrameForgeEpisodeModel.create(0, { shotCount: project.meta.shotsPerEpisode || 5 });
  project.episodes.push(episode);
  project.selectedEpisodeId = episode.id;
  return episode;
}
function syncEpisodeFromForm() {
  const episode = activeEpisode();
  if (!episode || !elements.episodeTitle) return;
  episode.meta.title = elements.episodeTitle.value.trim() || `第${episode.order + 1}集`;
  episode.meta.synopsis = elements.episodeSynopsis.value.trim();
  episode.meta.objective = elements.episodeObjective.value.trim();
  episode.meta.hook = elements.episodeHook.value.trim();
  episode.meta.ending = elements.episodeEnding.value.trim();
  episode.meta.shotCount = Math.max(1, Number(elements.episodeShotCount.value) || project.meta.shotsPerEpisode || 5);
}
function applyEpisodeToForm() {
  const episode = activeEpisode();
  elements.episodeSettings.hidden = !episode;
  if (!episode) return;
  elements.episodeTitle.value = episode.meta.title || `第${episode.order + 1}集`;
  elements.episodeSynopsis.value = episode.meta.synopsis || "";
  elements.episodeObjective.value = episode.meta.objective || "";
  elements.episodeHook.value = episode.meta.hook || "";
  elements.episodeEnding.value = episode.meta.ending || "";
  elements.episodeShotCount.value = String(episode.meta.shotCount || project.meta.shotsPerEpisode || 5);
  $("#deleteEpisodeBtn").disabled = project.episodes.length <= 1;
}
function selectEpisode(episodeId) {
  if (episodeId === project.selectedEpisodeId) return;
  syncEditorToScene();
  syncEpisodeFromForm();
  project.selectedEpisodeId = episodeId;
  const episode = activeEpisode();
  if (episode) episode.selectedSceneId = episode.selectedSceneId || episode.startSceneId || episode.scenes[0]?.id || null;
  saveProject();
  render();
}
function renderEpisodeList() {
  if (!elements.episodeList) return;
  elements.episodeList.innerHTML = "";
  [...project.episodes].sort((a, b) => a.order - b.order).forEach((episode, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `episode-card${episode.id === project.selectedEpisodeId ? " active" : ""}`;
    card.draggable = true;
    card.dataset.episodeId = episode.id;
    card.innerHTML = `<span>第${index + 1}集</span><strong>${escapeHtml(episode.meta.title || `第${index + 1}集`)}</strong><small>${episode.scenes.length}/${episode.meta.shotCount || 5} 镜</small>`;
    card.addEventListener("click", () => selectEpisode(episode.id));
    card.addEventListener("dragstart", () => { draggedEpisodeId = episode.id; card.classList.add("dragging"); });
    card.addEventListener("dragover", (event) => { if (draggedEpisodeId && draggedEpisodeId !== episode.id) { event.preventDefault(); card.classList.add("drag-over"); } });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = project.episodes.findIndex((item) => item.id === draggedEpisodeId);
      const to = project.episodes.findIndex((item) => item.id === episode.id);
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = project.episodes.splice(from, 1);
        project.episodes.splice(to, 0, moved);
        window.FrameForgeEpisodeModel.normalizeEpisodes(project);
        saveProject(); render();
      }
    });
    card.addEventListener("dragend", () => { draggedEpisodeId = null; card.classList.remove("dragging", "drag-over"); });
    elements.episodeList.appendChild(card);
  });
  applyEpisodeToForm();
}
function addEpisode() {
  syncEditorToScene(); syncEpisodeFromForm();
  const episode = window.FrameForgeEpisodeModel.create(project.episodes.length, { shotCount: project.meta.shotsPerEpisode || 5 });
  project.episodes.push(episode);
  project.selectedEpisodeId = episode.id;
  project.meta.episodeCount = project.episodes.length;
  $("#projectEpisodeCount").value = String(project.episodes.length);
  saveProject(); render();
}
function deleteEpisode() {
  const episode = activeEpisode();
  if (!episode || project.episodes.length <= 1) return;
  if (!confirm(`删除“${episode.meta.title}”及其中 ${episode.scenes.length} 个镜头？`)) return;
  const index = project.episodes.findIndex((item) => item.id === episode.id);
  project.episodes.splice(index, 1);
  window.FrameForgeEpisodeModel.normalizeEpisodes(project);
  project.selectedEpisodeId = project.episodes[Math.min(index, project.episodes.length - 1)]?.id || null;
  project.meta.episodeCount = project.episodes.length;
  $("#projectEpisodeCount").value = String(project.episodes.length);
  saveProject(); render();
}
function syncEpisodesToPlan() {
  syncEditorToScene(); syncEpisodeFromForm();
  const target = Math.max(1, Math.min(100, Number($("#projectEpisodeCount").value) || 1));
  if (target < project.episodes.length) {
    const removed = project.episodes.slice(target);
    const sceneCount = removed.reduce((sum, episode) => sum + episode.scenes.length, 0);
    if (!confirm(`将删除后 ${removed.length} 集及其中 ${sceneCount} 个镜头，继续吗？`)) return;
    project.episodes.splice(target);
  }
  while (project.episodes.length < target) {
    project.episodes.push(window.FrameForgeEpisodeModel.create(project.episodes.length, { shotCount: project.meta.shotsPerEpisode || 5 }));
  }
  window.FrameForgeEpisodeModel.normalizeEpisodes(project);
  project.meta.episodeCount = project.episodes.length;
  ensureAtLeastOneEpisode();
  saveProject(); render();
  showToast(`已同步为 ${project.episodes.length} 集。`);
}
function selectedScene() {
  return project.scenes.find((scene) => scene.id === project.selectedSceneId);
}
function orderedScenes() {
  return [...project.scenes].sort((left, right) => left.order - right.order);
}
function normalizeSceneOrder() {
  project.scenes = orderedScenes();
  project.scenes.forEach((scene, index) => {
    scene.order = index;
    if (currentMode === "serial") {
      scene.episode = (activeEpisode()?.order || 0) + 1;
      scene.episodeOrder = index + 1;
    }
  });
}
function moveSceneRelative(draggedId, targetId, placeAfter = false) {
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

function createScene(partial = {}) {
  return {
    id: uid(), title: "新镜头", shot: "中景", duration: 8,
    action: "", dialogue: "", imagePrompt: "", videoPrompt: "",
    imageUrl: "", videoUrl: "", imageLocalUrl: "", videoLocalUrl: "",
    imageStatus: "idle", videoStatus: "idle",
    imagePredictionId: "", videoPredictionId: "",
    nextSceneId: "", choices: [], referenceSceneId: "",
    transition: "match", entryState: "", exitState: "",
    order: project?.scenes?.length || 0,
    episode: 1, episodeOrder: (project?.scenes?.length || 0) + 1,
    ...partial,
  };
}

// ─────────────────────────────────────────────
//  提示词合成
// ─────────────────────────────────────────────
function stripEpisodePlanningContext(prompt) {
  return String(prompt || "")
    .split("\n")
    .filter((line) => !/^\s*(本集设定|本集叙事|全剧梗概|本集梗概|叙事目标|结尾目标)[：:]/.test(line))
    .join("\n")
    .trim();
}

function spokenCharacterCount(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

function dialogueBudget(duration) {
  return Math.max(0, Math.floor((Number(duration) - 1.5) * 3));
}

function recommendedDialogueDuration(dialogue) {
  const required = Math.ceil(spokenCharacterCount(dialogue) / 3 + 1.5);
  return [4, 6, 8, 10, 12, 15].find((duration) => duration >= required) || 15;
}

function narrativeSentences(value) {
  return String(value || "").split(/(?<=[。！？!?；;])\s*/).map((item) => item.trim()).filter(Boolean);
}

function atomicNarrativeBeat(value, fallback) {
  const sentence = narrativeSentences(value)[0] || fallback;
  return String(sentence || "").slice(0, 160);
}

function serialSceneNeighbors(scene) {
  const scenes = orderedScenes();
  const index = scenes.findIndex((candidate) => candidate.id === scene.id);
  return {
    previous: index > 0 ? scenes[index - 1] : null,
    next: index >= 0 && index + 1 < scenes.length ? scenes[index + 1] : null,
  };
}

function inferEntryState(scene, previous) {
  if (scene.entryState) return scene.entryState;
  if (previous?.exitState) return previous.exitState;
  return previous ? `承接上一镜“${previous.title}”结束时的人物位置、视线、道具和情绪。` : "从稳定定场状态开始。";
}

function inferExitState(scene, next) {
  if (scene.exitState) return scene.exitState;
  const action = narrativeSentences(scene.action).slice(-1)[0] || scene.action || "人物动作短暂停留";
  return `${String(action).slice(0, 120)}；结尾保持可衔接的姿势与视线${next ? `，为“${next.title}”留出动作方向` : ""}。`;
}

function transitionLabel(value) {
  return { match: "动作匹配", dissolve: "柔和淡变", cut: "直接切换", fade: "淡入淡出" }[value] || "动作匹配";
}

function rebuildSerialTransitions(showResult = false, preserveCamera = false, force = false) {
  if (currentMode !== "serial") return;
  const scenes = orderedScenes();
  if (force) scenes.forEach((scene) => { scene.entryState = ""; scene.exitState = ""; });
  scenes.forEach((scene, index) => {
    const previous = scenes[index - 1] || null;
    const next = scenes[index + 1] || null;
    scene.transition = index === 0 ? "cut" : (scene.transition || "match");
    scene.entryState = inferEntryState(scene, previous);
    scene.exitState = inferExitState(scene, next);
    if (previous && !previous.exitState) previous.exitState = scene.entryState;
  });
  scenes.forEach((scene) => {
    scene.videoPrompt = preserveCamera
      ? mergeVideoNarrativeContext(scene.videoPrompt, scene)
      : composeVideoPrompt(scene);
  });
  if (showResult) { saveProject(); renderEditor(); showToast(`已重建 ${scenes.length} 个镜头的衔接状态。`); }
}

function composeImagePrompt(scene) {
  const meta = readMetaFromForm();
  const modeLabel = currentMode === "serial" ? "AI短剧" : `${meta.genre}互动影游`;
  const entryState = currentMode === "serial" ? inferEntryState(scene, serialSceneNeighbors(scene).previous) : "";
  return [
    `${modeLabel}的电影关键帧，${scene.shot}。`,
    entryState ? `这是当前视频的起始帧，人物、视线、位置、道具和环境必须准确处于入口状态：${entryState}` : "",
    `当前镜头唯一事件与表演：${scene.action || "角色处于故事场景中"}。`,
    meta.character ? `角色连续性设定：${meta.character}。` : "",
    meta.visualStyle ? `视觉风格：${meta.visualStyle}。` : "",
    `只表现当前镜头，不概括、不预演本集其他情节。构图适合${meta.aspectRatio}画幅，电影灯光，无文字、无水印、无界面元素。`,
  ].filter(Boolean).join("\n");
}

function composeVideoPrompt(scene) {
  const cameraPrompt = [
    `${scene.shot}电影镜头。`,
    "保持首帧人物身份、脸部、服装和场景结构一致。",
    "自然呼吸与细微环境动态，运动连贯，镜头稳定，避免形体变形、闪烁、跳切和新增角色。",
  ].filter(Boolean).join(" ");
  return mergeVideoNarrativeContext(cameraPrompt, scene);
}

function videoNarrativeContext(scene) {
  const { previous, next } = currentMode === "serial" ? serialSceneNeighbors(scene) : { previous: null, next: null };
  const action = scene.action || "角色保持自然细微动作，延续上一镜头的情绪与空间关系。";
  const dialogue = scene.dialogue || "无对白或旁白，以动作、表情和环境声推进叙事。";
  const entryState = inferEntryState(scene, previous);
  const exitState = inferExitState(scene, next);
  return [
    "【当前镜头】",
    currentMode === "serial" ? `衔接方式：${transitionLabel(scene.transition)}。` : "",
    currentMode === "serial" ? `开头入口状态：${entryState}` : "",
    `本镜头唯一事件与表演：${action}`,
    `本镜头对白 / 旁白：${dialogue}`,
    currentMode === "serial" ? `结尾出口状态：${exitState}` : "",
    `时长：${scene.duration || 8} 秒。对白必须在该时长内以自然、清晰、可听懂的语速完成，并保留必要停顿。`,
    currentMode === "serial" ? "开头约 0.3 秒准确保持入口状态，再自然开始动作；结尾约 0.3 秒收束到出口状态并稳定停留，期间避免新增动作或台词，为下一镜转场预留余量。" : "",
    "只执行上述一个镜头事件，不总结、不预演、不补演本集其他情节，不朗读剧情描述。动作、表情、视线和口型仅服务于当前对白；保持人物运动方向、屏幕方位和环境光线连续。画面不显示字幕或文字。",
    "【/当前镜头】",
  ].filter(Boolean).join("\n");
}

function mergeVideoNarrativeContext(prompt, scene) {
  const cameraPrompt = String(prompt || "")
    .replace(/\n?【剧情连续性】[\s\S]*?【\/剧情连续性】/g, "")
    .replace(/\n?【当前镜头】[\s\S]*?【\/当前镜头】/g, "")
    .split("\n")
    .filter((line) => !/^\s*(本集设定|本集叙事|全剧梗概|本集梗概|叙事目标|结尾目标)[：:]/.test(line))
    .join("\n")
    .trim();
  return [cameraPrompt, videoNarrativeContext(scene)].filter(Boolean).join("\n\n");
}

// ─────────────────────────────────────────────
//  互动影游草案生成
// ─────────────────────────────────────────────
function draftRequestMeta() {
  const meta = readMetaFromForm();
  const episode = currentMode === "serial" ? ensureAtLeastOneEpisode() : null;
  if (!meta.synopsis.trim() && !episode?.meta.synopsis.trim()) { showToast("请先填写项目故事梗概或本集剧情梗概。", true); return null; }
  if (currentMode === "interactive") {
    const nodeCount = estimatedTreeNodes(meta.treeDepth, meta.branchCount);
    if (nodeCount > 160) {
      showToast(`该组合会生成 ${nodeCount} 个节点，超过 160 个安全上限。请降低深度或分支数。`, true);
      return null;
    }
    return { meta, nodeCount };
  }
  // 短剧模式
  syncEpisodeFromForm();
  const nodeCount = episode.meta.shotCount || meta.shotsPerEpisode;
  if (nodeCount > 200) {
    showToast(`当前集会生成 ${nodeCount} 个镜头，超过 200 个上限。请降低目标镜头数。`, true);
    return null;
  }
  return { meta, nodeCount, episode };
}

function confirmDraftReplacement() {
  if (!project.scenes.length) return true;
  const scope = currentMode === "serial" ? `当前集“${activeEpisode()?.meta.title || "未命名"}”的全部镜头` : "当前全部剧情节点";
  return confirm(`生成草案会替换${scope}，但不会删除已保存到磁盘的素材。继续吗？`);
}

function estimatedTreeNodes(depth, branches) {
  return Array.from({ length: depth }, (_, level) => branches ** level).reduce((sum, value) => sum + value, 0);
}
function updateTreeEstimate() {
  const depth = Number(elements.projectTreeDepth.value || 3);
  const branches = Number(elements.projectBranchCount.value || 2);
  const nodes = estimatedTreeNodes(depth, branches);
  const endings = branches ** (depth - 1);
  const estimate = $("#treeEstimate");
  estimate.textContent = `预计 ${nodes} 个节点 · ${endings} 个结局`;
  estimate.className = `tree-estimate${nodes > 160 ? " warning" : ""}`;
  $("#draftBtn").disabled = nodes > 160;
}
function updateSerialEstimate() {
  const episodes = Number($("#projectEpisodeCount")?.value || 5);
  const shots = Number($("#projectShotsPerEpisode")?.value || 12);
  const configuredTotal = project?.episodes?.reduce((sum, episode) => sum + (Number(episode.meta?.shotCount) || shots), 0) || 0;
  const total = configuredTotal || episodes * shots;
  const currentShots = activeEpisode()?.meta.shotCount || shots;
  const estimate = $("#serialEstimate");
  if (estimate) {
    estimate.textContent = `当前集 ${currentShots} 镜 · 全剧计划 ${episodes} 集 / ${total} 镜`;
    estimate.className = `tree-estimate${total > 200 ? " warning" : ""}`;
  }
  if ($("#draftBtn")) $("#draftBtn").disabled = currentShots > 200;
}

function buildLocalDraft() {
  if (currentMode === "serial") { buildLocalSerialDraft(); return; }
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, nodeCount } = request;
  project.meta = meta;
  project.scenes = [];
  const levels = [];
  const stageNames = ["序幕", "探索", "线索", "抉择", "终局"];
  const actions = ["谨慎调查异常源", "追踪隐藏线索", "面对意外阻碍", "验证关键证据"];
  for (let level = 0; level < meta.treeDepth; level += 1) {
    const count = meta.branchCount ** level;
    const levelScenes = [];
    for (let position = 0; position < count; position += 1) {
      const isRoot = level === 0;
      const isEnding = level === meta.treeDepth - 1;
      const routeCode = position.toString(meta.branchCount).padStart(level, "0").split("").map((digit) => String.fromCharCode(65 + Number(digit))).join("-");
      const title = isRoot ? "序幕：命运起点" : isEnding ? `结局 ${routeCode}` : `${stageNames[Math.min(level, stageNames.length - 2)]} ${routeCode}`;
      const action = isRoot
        ? `建立故事世界与核心危机。${meta.synopsis} 主角发现多个可能改变命运的行动方向。`
        : isEnding
          ? `此前路线 ${routeCode} 的选择共同塑造最终结果。主角承担选择的代价，故事抵达独立结局。`
          : `沿路线 ${routeCode} 推进剧情。主角${actions[(level + position) % actions.length]}，获得新的信息，同时失去另一种可能。`;
      const scene = createScene({ title, shot: isRoot ? "大全景" : isEnding ? "全景" : level % 2 ? "中景" : "近景", action, dialogue: isRoot ? "我的选择会改变接下来的一切。" : isEnding ? "这就是我选择的未来。" : "每条路，都在揭示不同的真相。" });
      scene.imagePrompt = composeImagePrompt(scene);
      scene.videoPrompt = composeVideoPrompt(scene);
      project.scenes.push(scene); levelScenes.push(scene);
    }
    levels.push(levelScenes);
  }
  for (let level = 0; level < levels.length - 1; level += 1) {
    levels[level].forEach((scene, parentIndex) => {
      scene.choices = Array.from({ length: meta.branchCount }, (_, branchIndex) => {
        const target = levels[level + 1][parentIndex * meta.branchCount + branchIndex];
        return { id: choiceUid(), text: `选择 ${String.fromCharCode(65 + branchIndex)}：${["冒险追寻真相", "谨慎保存实力", "相信眼前盟友", "独自承担风险"][branchIndex]}`, effect: `进入路线 ${target.title.replace(/^(探索|线索|抉择|结局)\s*/, "")}`, targetSceneId: target.id };
      });
    });
  }
  const intro = levels[0][0];
  project.startSceneId = intro.id;
  project.scenes.forEach((scene) => { scene.referenceSceneId = scene.id === intro.id ? "" : intro.id; });
  normalizeSceneOrder();
  project.selectedSceneId = intro.id;
  saveProject(); render();
  showToast(`本地模板已生成 ${nodeCount} 个剧情节点。`);
}

// ─────────────────────────────────────────────
//  AI短剧草案生成
// ─────────────────────────────────────────────
function buildLocalSerialDraft() {
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, episode } = request;
  project.meta = meta;
  project.scenes = [];
  const toneLabels = { drama: "情感正剧", thriller: "悬疑惊悚", comedy: "轻喜剧", action: "动作冒险", romance: "爱情甜宠" };
  const toneLabel = toneLabels[meta.serialTone] || "剧情";
  const episodeNumber = episode.order + 1;
  const shotCount = episode.meta.shotCount || meta.shotsPerEpisode;
  const shotNames = ["开场钩子", "人物反应", "冲突推进", "信息揭示", "情绪特写", "高潮反转", "结尾悬念"];
  const middleBeats = [
    ...narrativeSentences(episode.meta.synopsis),
    ...narrativeSentences(episode.meta.objective),
  ];
  for (let shot = 1; shot <= shotCount; shot += 1) {
    const isFirst = shot === 1;
    const isLast = shot === shotCount;
    const shotName = shotNames[Math.min(shot - 1, shotNames.length - 1)];
    const action = isFirst
      ? atomicNarrativeBeat(episode.meta.hook || episode.meta.synopsis || meta.synopsis, `以一个明确异常事件建立${toneLabel}基调。`)
      : isLast
        ? atomicNarrativeBeat(episode.meta.ending, "主角看见新的关键证据，情绪骤变，镜头停在未解悬念上。")
        : atomicNarrativeBeat(
          middleBeats[(shot - 2) % Math.max(1, middleBeats.length)],
          `${meta.character || "主角"}${["采取一个具体行动推进目标", "遭遇一个新的阻碍", "与关键人物完成一次交锋", "发现一条改变判断的信息"][shot % 4]}。`,
        );
    const scene = createScene({
      title: `第${episodeNumber}集 · ${shotName}`,
      shot: isFirst ? "大全景" : isLast ? "特写" : ["近景", "中景", "特写", "中景"][shot % 4],
      action,
      dialogue: isFirst ? "这一切，必须从现在改变。" : isLast ? "真正的答案，才刚刚出现。" : "",
      episode: episodeNumber, episodeOrder: shot, order: shot - 1,
      transition: isFirst ? "cut" : "match",
    });
    scene.imagePrompt = composeImagePrompt(scene);
    scene.videoPrompt = composeVideoPrompt(scene);
    project.scenes.push(scene);
  }
  for (let i = 0; i < project.scenes.length - 1; i += 1) {
    project.scenes[i].nextSceneId = project.scenes[i + 1].id;
    project.scenes[i].choices = [];
  }
  project.scenes[project.scenes.length - 1].nextSceneId = "";
  rebuildSerialTransitions();
  const firstScene = project.scenes[0];
  project.startSceneId = firstScene.id;
  const seriesMaster = firstEpisodeMasterScene();
  project.scenes.forEach((scene) => {
    scene.referenceSceneId = scene.id === firstScene.id
      ? (episode.order > 0 && seriesMaster?.id !== scene.id ? seriesMaster?.id || "" : "")
      : firstScene.id;
  });
  normalizeSceneOrder();
  project.selectedSceneId = firstScene.id;
  saveProject(); render();
  showToast(`“${episode.meta.title}”已生成 ${project.scenes.length} 个镜头。`);
}

// 短剧 AI 生成
async function generateSerialDraft() {
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, episode } = request;
  saveProviderSecrets();
  const provider = providerSettings("text");
  const button = $("#draftBtn");
  button.disabled = true; button.textContent = "文本模型生成中…";
  const toneLabels = { drama: "情感正剧", thriller: "悬疑惊悚", comedy: "轻喜剧", action: "动作冒险", romance: "爱情甜宠" };
  const episodeNumber = episode.order + 1;
  const previousEpisode = project.episodes[episode.order - 1];
  const nextEpisode = project.episodes[episode.order + 1];
  const serialPrompt = `你是一名专业短剧编剧。请为一部${toneLabels[meta.serialTone] || "短剧"}创作第 ${episodeNumber} 集的分镜脚本，共 ${episode.meta.shotCount} 个镜头。

【项目级设定】
片名：${meta.title}
全剧梗概：${meta.synopsis}
类型与基调：${meta.genre} / ${meta.serialTone}
固定角色：${meta.character || "待定"}
统一视觉风格：${meta.visualStyle || "现代电影质感"}

【本集设定】
本集标题：${episode.meta.title}
本集梗概：${episode.meta.synopsis || "根据全剧梗概推进"}
叙事目标：${episode.meta.objective || "推进主线与人物关系"}
开场钩子：${episode.meta.hook || "前几个镜头迅速建立冲突"}
高潮与结尾：${episode.meta.ending || "形成高潮，并留下下一集悬念"}
上一集：${previousEpisode ? `${previousEpisode.meta.title}；${previousEpisode.meta.ending || previousEpisode.meta.synopsis}` : "无，这是开篇"}
下一集：${nextEpisode ? nextEpisode.meta.title : "未设定或全剧收束"}

返回严格的 JSON，格式如下（不要 markdown 围栏）：
{
  "startKey": "shot_1",
  "scenes": [
    {
      "key": "shot_1",
      "episodeOrder": 1,
      "title": "开场钩子",
      "shot": "大全景",
      "duration": 8,
      "action": "场景描述与表演",
      "dialogue": "对白或旁白",
      "transition": "match",
      "entryState": "本镜开始时的人物姿势、视线、位置、道具与情绪",
      "exitState": "本镜结束时留给下一镜的人物姿势、视线、位置、道具与情绪",
      "nextKey": "shot_2"
    }
  ]
}

要求：
1. 严格返回 ${episode.meta.shotCount} 个镜头，镜头之间线性连接，最后一个镜头 nextKey 为空字符串。
2. 先在内部把本集拆成 ${episode.meta.shotCount} 个连续节拍，再逐镜输出；每个镜头只发生一个不可再分的事件或表演动作，禁止在任一 action 中复述本集梗概、叙事目标或完整结局。
3. 每镜 action 只描述该镜头可见的动作、表情、空间变化与即时结果，不写后续镜头内容，不使用“随后、接着、最终”等跨镜头概括。
4. dialogue 只包含当前镜头实际说出的对白或旁白，不得朗读 action 或剧情梗概。按每秒最多约 3 个中文字计算：4秒不超过7字、6秒不超过13字、8秒不超过19字、10秒不超过25字、12秒不超过31字、15秒不超过40字；需要更多对白时必须拆到后续镜头。
5. 人物身份、服装、地点状态和情绪在相邻镜头间连续，但连续性信息不得替代当前镜头事件。
6. 每镜必须给出 entryState 与 exitState；第 N 镜的 exitState 必须能直接成为第 N+1 镜的 entryState。保持人物屏幕方向、动作方向、视线、手中道具、环境光线和声音底噪连续。
7. transition 只能是 match、dissolve、cut、fade；同一场景连续动作优先 match，时间或地点轻微变化用 dissolve，强烈段落转换才用 cut 或 fade。`;

  try {
    const result = await requestJson("/api/generate-episode", { method: "POST", body: JSON.stringify({
      model: meta.textModel,
      text_base_url: provider.baseUrl,
      text_api_key: provider.apiKey,
      prompt: serialPrompt,
    }) });
    installGeneratedSerial(parseStoryJson(result), meta, episode);
  } catch (error) {
    showToast(`${error.message} 可改用"本地模板生成"。`, true);
  } finally {
    button.disabled = false; button.textContent = "使用文本模型生成当前集";
  }
}

function installGeneratedSerial(generated, meta, episode) {
  if (!generated || !Array.isArray(generated.scenes) || !generated.scenes.length) {
    throw new Error("文本模型没有返回 scenes 数组。");
  }
  if (generated.scenes.length > 200) throw new Error("文本模型返回超过 200 个镜头，已拒绝导入。");
  const keys = new Set();
  generated.scenes.forEach((item, index) => {
    const key = String(item?.key || `n${index}`);
    if (keys.has(key)) throw new Error(`重复节点 key：${key}`);
    keys.add(key);
  });
  const episodeNumber = episode.order + 1;
  const scenes = generated.scenes.map((item, index) => {
    const dialogue = String(item.dialogue || "").slice(0, 3000);
    const requestedDuration = [4, 6, 8, 10, 12, 15].includes(Number(item.duration)) ? Number(item.duration) : 8;
    const fittedDuration = spokenCharacterCount(dialogue) > dialogueBudget(requestedDuration)
      ? recommendedDialogueDuration(dialogue)
      : requestedDuration;
    return createScene({
    order: index,
    title: String(item.title || `镜头 ${index + 1}`).slice(0, 80),
    shot: ["大全景", "全景", "中景", "近景", "特写"].includes(item.shot) ? item.shot : "中景",
    duration: fittedDuration,
    action: String(item.action || "").slice(0, 6000),
    dialogue,
    transition: ["match", "dissolve", "cut", "fade"].includes(item.transition) ? item.transition : (index ? "match" : "cut"),
    entryState: String(item.entryState || "").slice(0, 1000),
    exitState: String(item.exitState || "").slice(0, 1000),
    episode: episodeNumber,
    episodeOrder: Number(item.episodeOrder) || (index + 1),
    choices: [],
    });
  });
  const idByKey = new Map(generated.scenes.map((item, index) => [String(item?.key || `n${index}`), scenes[index].id]));
  generated.scenes.forEach((item, index) => {
    scenes[index].nextSceneId = idByKey.get(String(item?.nextKey || "")) || "";
    scenes[index].imagePrompt = composeImagePrompt(scenes[index]);
    scenes[index].videoPrompt = composeVideoPrompt(scenes[index]);
  });
  const startId = idByKey.get(String(generated.startKey || generated.scenes[0]?.key || "")) || scenes[0].id;
  const seriesMaster = firstEpisodeMasterScene();
  scenes.forEach((scene) => {
    scene.referenceSceneId = scene.id === startId
      ? (episode.order > 0 && seriesMaster?.id !== scene.id ? seriesMaster?.id || "" : "")
      : startId;
  });
  project.meta = meta;
  project.scenes = scenes;
  project.startSceneId = startId;
  project.selectedSceneId = startId;
  normalizeSceneOrder();
  rebuildSerialTransitions();
  saveProject(); render();
  showToast(`“${episode.meta.title}”已生成 ${scenes.length} 个镜头。`);
}

async function generateStoryDraft() {
  if (currentMode === "serial") { await generateSerialDraft(); return; }
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, nodeCount } = request;
  saveProviderSecrets();
  const provider = providerSettings("text");
  const button = $("#draftBtn");
  button.disabled = true; button.textContent = "文本模型生成中…";
  try {
    const result = await requestJson("/api/generate-story", { method: "POST", body: JSON.stringify({
      model: meta.textModel,
      text_base_url: provider.baseUrl,
      text_api_key: provider.apiKey,
      title: meta.title,
      synopsis: meta.synopsis,
      genre: meta.genre,
      character: meta.character,
      visual_style: meta.visualStyle,
      tree_depth: meta.treeDepth,
      branch_count: meta.branchCount,
    }) });
    installGeneratedStory(parseStoryJson(result), meta, nodeCount);
  } catch (error) {
    showToast(`${error.message} 可改用"本地模板生成"。`, true);
  } finally {
    button.disabled = nodeCount > 160;
    button.textContent = "使用文本模型生成";
  }
}

// ─────────────────────────────────────────────
//  JSON 解析 / 互动影游安装
// ─────────────────────────────────────────────
function extractAssistantContent(result) {
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").join("");
  throw new Error("文本模型没有返回可读取的剧情内容。");
}

function parseStoryJson(result) {
  const raw = extractAssistantContent(result)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const jsonText = extractFirstJsonObject(raw);
  try { return JSON.parse(jsonText); }
  catch { throw new Error("文本模型返回的剧情不是有效 JSON，请重试或更换文本模型。"); }
}

function extractFirstJsonObject(text) {
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

async function testTextProvider() {
  saveProject(); saveProviderSecrets();
  const meta = readMetaFromForm();
  const provider = providerSettings("text");
  const button = $("#testTextProviderBtn");
  button.disabled = true; button.textContent = "连接测试中…";
  try {
    const result = await requestJson("/api/test-text-provider", { method: "POST", body: JSON.stringify({
      text_base_url: provider.baseUrl, text_api_key: provider.apiKey, model: meta.textModel,
    }) });
    showToast(`文本模型连接成功：${result.model} · 后端 ${result.version}`);
  } catch (error) { showToast(`文本模型连接失败：${error.message}`, true); }
  finally { button.disabled = false; button.textContent = "测试文本模型连接"; }
}

function installGeneratedStory(generated, meta, expectedNodes) {
  if (!generated || !Array.isArray(generated.scenes) || !generated.scenes.length) throw new Error("文本模型没有返回 scenes 数组。");
  if (generated.scenes.length > 160) throw new Error("文本模型返回超过 160 个节点，已拒绝导入。");
  const keys = new Set();
  generated.scenes.forEach((item, index) => {
    const key = String(item?.key || `n${index}`);
    if (keys.has(key)) throw new Error(`文本模型返回了重复节点 key：${key}`);
    keys.add(key);
  });
  generated.scenes.forEach((item) => {
    (Array.isArray(item?.choices) ? item.choices : []).forEach((choice) => {
      const targetKey = String(choice?.targetKey || "");
      if (!targetKey || !keys.has(targetKey)) throw new Error(`文本模型返回了无效的选择目标：${targetKey || "空值"}`);
    });
  });
  const scenes = generated.scenes.map((item, index) => createScene({
    order: index,
    title: String(item.title || `剧情节点 ${index + 1}`).slice(0, 80),
    shot: ["大全景", "全景", "中景", "近景", "特写"].includes(item.shot) ? item.shot : "中景",
    duration: [4, 6, 8, 10, 12, 15].includes(Number(item.duration)) ? Number(item.duration) : 8,
    action: String(item.action || "").slice(0, 6000),
    dialogue: String(item.dialogue || "").slice(0, 3000),
  }));
  const idByKey = new Map(generated.scenes.map((item, index) => [String(item?.key || `n${index}`), scenes[index].id]));
  generated.scenes.forEach((item, index) => {
    const scene = scenes[index];
    scene.choices = (Array.isArray(item.choices) ? item.choices : []).map((choice) => ({
      id: choiceUid(), text: String(choice?.text || "未命名选择").slice(0, 100),
      effect: String(choice?.effect || "").slice(0, 180),
      targetSceneId: idByKey.get(String(choice?.targetKey || "")) || "",
    }));
    scene.nextSceneId = idByKey.get(String(item?.nextKey || "")) || "";
    scene.imagePrompt = composeImagePrompt(scene);
    scene.videoPrompt = composeVideoPrompt(scene);
  });
  const startId = idByKey.get(String(generated.startKey || generated.scenes[0]?.key || "")) || scenes[0].id;
  scenes.forEach((scene) => { scene.referenceSceneId = scene.id === startId ? "" : startId; });
  project.meta = meta;
  project.scenes = scenes;
  project.startSceneId = startId;
  project.selectedSceneId = startId;
  normalizeSceneOrder();
  saveProject(); render();
  const mismatch = scenes.length === expectedNodes ? "" : `，模型实际返回 ${scenes.length}/${expectedNodes} 个节点`;
  showToast(`文本模型剧情草案已生成${mismatch}。`);
}

// ─────────────────────────────────────────────
//  分镜列表渲染
// ─────────────────────────────────────────────
function renderSceneList() {
  if (currentMode === "serial") {
    const filter = $("#serialEpisodeFilter");
    if (filter) {
      filter.innerHTML = project.episodes.map((episode, index) => `<option value="${episode.id}"${episode.id === project.selectedEpisodeId ? " selected" : ""}>第${index + 1}集 · ${escapeHtml(episode.meta.title)}</option>`).join("");
    }
  }

  elements.sceneList.innerHTML = "";
  const scenes = orderedScenes();

  scenes.forEach((scene, index) => {
    const item = document.createElement("div");
    item.className = `scene-item${scene.id === project.selectedSceneId ? " active" : ""}`;
    item.draggable = true;
    item.dataset.sceneId = scene.id;
    let metaText = "";
    if (currentMode === "serial") {
      metaText = `第${activeEpisode()?.order + 1 || 1}集 · ${scene.episodeOrder || (index + 1)}号 · ${escapeHtml(scene.shot)} · ${scene.duration} 秒`;
    } else {
      const flowLabel = scene.choices.length ? `${scene.choices.length} 个选择` : scene.nextSceneId ? "自动连接" : "结局";
      metaText = `${escapeHtml(scene.shot)} · ${scene.duration} 秒 · ${flowLabel}`;
    }
    item.innerHTML = `<span class="scene-index">${String(index + 1).padStart(2, "0")}</span>
      <strong></strong><span class="scene-meta">${metaText}</span>
      ${scene.id === project.startSceneId ? '<span class="start-badge">起点</span>' : ""}
      <span class="asset-dots"><i class="${statusClass(scene.imageStatus, scene.imageUrl)}"></i><i class="${statusClass(scene.videoStatus, scene.videoUrl)}"></i></span>`;
    item.querySelector("strong").textContent = scene.title;
    item.addEventListener("click", () => { syncEditorToScene(); project.selectedSceneId = scene.id; saveProject(); render(); });
    bindSceneDrag(item, scene.id, "list");
    elements.sceneList.appendChild(item);
  });
}

function clearDragStyles() {
  document.querySelectorAll(".dragging, .drag-over, .drag-invalid").forEach((element) => {
    element.classList.remove("dragging", "drag-over", "drag-invalid");
  });
}

function bindSceneDrag(element, sceneId, source, depthById = null) {
  element.addEventListener("dragstart", (event) => {
    draggedSceneId = sceneId; draggedSceneSource = source;
    element.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sceneId);
  });
  element.addEventListener("dragover", (event) => {
    if (!draggedSceneId || draggedSceneId === sceneId) return;
    event.preventDefault();
    const invalidTreeMove = source === "tree" && draggedSceneSource === "tree" && depthById?.get(draggedSceneId) !== depthById?.get(sceneId);
    element.classList.toggle("drag-invalid", invalidTreeMove);
    element.classList.toggle("drag-over", !invalidTreeMove);
    event.dataTransfer.dropEffect = invalidTreeMove ? "none" : "move";
  });
  element.addEventListener("dragleave", () => element.classList.remove("drag-over", "drag-invalid"));
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    const invalidTreeMove = source === "tree" && draggedSceneSource === "tree" && depthById?.get(draggedSceneId) !== depthById?.get(sceneId);
    if (invalidTreeMove) {
      showToast("剧情树中只能调整同一层节点的顺序；分支连接关系不会被拖拽改写。", true);
    } else {
      const bounds = element.getBoundingClientRect();
      const placeAfter = event.clientY > bounds.top + bounds.height / 2;
      if (!moveSceneRelative(draggedSceneId, sceneId, placeAfter)) return;
      renderSceneList();
      if (!elements.treeModal.hidden) renderTreeBrowser();
      showToast("分镜顺序已更新，剧情连接关系保持不变。");
    }
    draggedSceneId = null; draggedSceneSource = ""; clearDragStyles();
  });
  element.addEventListener("dragend", () => { draggedSceneId = null; draggedSceneSource = ""; clearDragStyles(); });
}

function statusClass(status, url) {
  if (status === "working") return "working";
  if (status === "paused") return "paused";
  return url ? "done" : "";
}

// ─────────────────────────────────────────────
//  编辑器渲染
// ─────────────────────────────────────────────
function renderEditor() {
  const scene = selectedScene();
  elements.sceneEditor.hidden = !scene;
  elements.emptyState.hidden = Boolean(scene);
  if (!scene) return;
  elements.sceneTitle.value = scene.title;
  elements.sceneShot.value = scene.shot;
  elements.sceneDuration.value = String(scene.duration);
  elements.sceneAction.value = scene.action;
  elements.sceneDialogue.value = scene.dialogue;
  updateDialogueTiming(scene);
  // 根据模式显示流程区
  if (currentMode === "interactive") {
    renderFlowEditor(scene);
  } else {
    renderSerialFlowEditor(scene);
  }
  renderReferenceSelector(scene);
  elements.sceneImagePrompt.value = scene.imagePrompt;
  elements.sceneVideoPrompt.value = scene.videoPrompt;
  renderMedia(scene);
  updateGenerationControls(scene);
}

function renderSerialFlowEditor(scene) {
  const epSelect = $("#sceneEpisode");
  if (epSelect) {
    const episodeNumber = (activeEpisode()?.order || 0) + 1;
    epSelect.innerHTML = `<option value="${episodeNumber}">第${episodeNumber}集 · ${escapeHtml(activeEpisode()?.meta.title || "")}</option>`;
    epSelect.disabled = true;
  }
  const orderInput = $("#sceneEpisodeOrder");
  if (orderInput) orderInput.value = scene.episodeOrder || 1;
  if (elements.sceneTransition) {
    elements.sceneTransition.value = scene.transition || (scene.episodeOrder === 1 ? "cut" : "match");
    elements.sceneTransition.disabled = scene.episodeOrder === 1;
  }
  if (elements.sceneEntryState) elements.sceneEntryState.value = inferEntryState(scene, serialSceneNeighbors(scene).previous);
  if (elements.sceneExitState) elements.sceneExitState.value = inferExitState(scene, serialSceneNeighbors(scene).next);
}

function updateGenerationControls(scene) {
  const imageButton = $("#generateImageBtn");
  const videoButton = $("#generateVideoBtn");
  imageButton.disabled = scene.imageStatus === "working";
  imageButton.textContent = scene.imageStatus === "working" ? "生成中…" : (scene.referenceSceneId ? "参考图生成关键帧" : "生成关键帧");
  videoButton.disabled = scene.videoStatus === "working";
  videoButton.textContent = scene.videoStatus === "working" ? "生成中…" : "由关键帧生成视频";
  $("#resetImageBtn").disabled = false;
  $("#resetVideoBtn").disabled = false;
}

function renderReferenceSelector(scene) {
  const options = ['<option value="">独立文生图（不参考其他镜头）</option>'];
  if (currentMode === "serial") {
    let currentEpisode = 0;
    serialSceneEntries().forEach(({ scene: candidate, episode, episodeNumber, sceneNumber }) => {
      if (episodeNumber !== currentEpisode) {
        if (currentEpisode) options.push("</optgroup>");
        options.push(`<optgroup label="第${episodeNumber}集 · ${escapeHtml(episode.meta.title || "未命名")}">`);
        currentEpisode = episodeNumber;
      }
      if (candidate.id === scene.id) return;
      const available = Boolean(candidate.imageUrl || candidate.imageLocalUrl);
      const selected = candidate.id === scene.referenceSceneId ? " selected" : "";
      options.push(`<option value="${escapeHtml(candidate.id)}"${selected}${available ? "" : " disabled"}>${String(sceneNumber).padStart(2, "0")} · ${escapeHtml(candidate.title)}${available ? "" : "（尚无关键帧）"}</option>`);
    });
    if (currentEpisode) options.push("</optgroup>");
  } else {
    orderedScenes().forEach((candidate, index) => {
      if (candidate.id === scene.id) return;
      const available = Boolean(candidate.imageUrl || candidate.imageLocalUrl);
      const selected = candidate.id === scene.referenceSceneId ? " selected" : "";
      options.push(`<option value="${escapeHtml(candidate.id)}"${selected}${available ? "" : " disabled"}>${String(index + 1).padStart(2, "0")} · ${escapeHtml(candidate.title)}${available ? "" : "（尚无关键帧）"}</option>`);
    });
  }
  elements.sceneReference.innerHTML = options.join("");
  const reference = findSceneAcrossProject(scene.referenceSceneId);
  if (!scene.referenceSceneId) {
    elements.referenceStatus.innerHTML = '<strong>文生图模式</strong><span>适合首镜头或纯环境镜头</span>';
  } else if (reference?.imageUrl || reference?.imageLocalUrl) {
    elements.referenceStatus.innerHTML = `<strong>角色一致性模式</strong><span>使用"${escapeHtml(reference.title)}"的主角身份</span>`;
  } else {
    elements.referenceStatus.innerHTML = '<strong class="warning-text">参考图尚未生成</strong><span>请先生成所选母版镜头</span>';
  }
  const button = $("#generateImageBtn");
  if (!button.disabled) button.textContent = scene.referenceSceneId ? "参考图生成关键帧" : "生成关键帧";
}

function sceneOptions(selectedId, excludeId = "") {
  const options = ['<option value="">— 无 / 剧情结束 —</option>'];
  orderedScenes().forEach((scene, index) => {
    if (scene.id === excludeId) return;
    const selected = scene.id === selectedId ? " selected" : "";
    options.push(`<option value="${escapeHtml(scene.id)}"${selected}>${String(index + 1).padStart(2, "0")} · ${escapeHtml(scene.title)}</option>`);
  });
  return options.join("");
}

function renderFlowEditor(scene) {
  elements.sceneNext.innerHTML = sceneOptions(scene.nextSceneId, scene.id);
  elements.choiceList.innerHTML = "";
  if (!scene.choices.length) {
    elements.choiceList.innerHTML = '<div class="choice-empty">当前没有玩家选择，播放结束后将自动进入"下一镜头"。</div>';
    return;
  }
  scene.choices.forEach((choice, index) => {
    const row = document.createElement("div");
    row.className = "choice-row";
    row.innerHTML = `<span class="choice-number">${index + 1}</span>
      <label>按钮文案<input class="choice-text" maxlength="100"></label>
      <label>指向节点<select class="choice-target">${sceneOptions(choice.targetSceneId, scene.id)}</select></label>
      <label class="choice-effect-label">剧情影响<input class="choice-effect" maxlength="180" placeholder="例如：获得信任，进入救援路线"></label>
      <button class="choice-remove" title="删除选择">×</button>`;
    row.querySelector(".choice-text").value = choice.text;
    row.querySelector(".choice-effect").value = choice.effect;
    row.querySelector(".choice-text").addEventListener("change", (event) => { choice.text = event.target.value.trim() || "未命名选择"; saveProject(); renderSceneList(); });
    row.querySelector(".choice-target").addEventListener("change", (event) => { choice.targetSceneId = event.target.value; saveProject(); renderSceneList(); });
    row.querySelector(".choice-effect").addEventListener("change", (event) => { choice.effect = event.target.value.trim(); saveProject(); });
    row.querySelector(".choice-remove").addEventListener("click", () => { scene.choices = scene.choices.filter((item) => item.id !== choice.id); saveProject(); renderFlowEditor(scene); renderSceneList(); });
    elements.choiceList.appendChild(row);
  });
}

function addChoice() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene) return;
  scene.choices.push({ id: choiceUid(), text: `选择 ${scene.choices.length + 1}`, effect: "", targetSceneId: "" });
  saveProject(); renderFlowEditor(scene); renderSceneList();
}

// ─────────────────────────────────────────────
//  分支检查（互动影游）
// ─────────────────────────────────────────────
function validateStoryGraph(showResult = true) {
  syncEditorToScene();
  syncEpisodeFromForm();
  if (currentMode === "serial") {
    const issues = [];
    project.episodes.forEach((episode, index) => {
      if (!episode.scenes.length) issues.push(`第${index + 1}集“${episode.meta.title}”没有镜头`);
      const ids = new Set(episode.scenes.map((scene) => scene.id));
      episode.scenes.forEach((scene) => {
        if (scene.nextSceneId && !ids.has(scene.nextSceneId)) issues.push(`第${index + 1}集“${scene.title}”指向本集之外或不存在的镜头`);
      });
    });
    if (showResult) {
      if (issues.length) showToast(`发现 ${issues.length} 个问题：${issues.slice(0, 3).join("；")}${issues.length > 3 ? "……" : ""}`, true);
      else showToast(`短剧检查通过：${project.episodes.length} 集，${window.FrameForgeEpisodeModel.allScenes(project).length} 个镜头。`);
    }
    return issues;
  }
  const issues = [];
  const sceneIds = new Set(project.scenes.map((scene) => scene.id));
  if (!project.scenes.length) issues.push("项目中没有剧情节点");
  if (!project.startSceneId || !sceneIds.has(project.startSceneId)) issues.push("尚未设置有效的剧情起点");
  project.scenes.forEach((scene) => {
    if (scene.nextSceneId && !sceneIds.has(scene.nextSceneId)) issues.push(`"${scene.title}"的下一镜头不存在`);
    scene.choices.forEach((choice) => {
      if (!choice.text.trim()) issues.push(`"${scene.title}"存在空白选择文案`);
      if (!choice.targetSceneId) issues.push(`"${scene.title}"的选择"${choice.text}"未指定目标`);
      else if (!sceneIds.has(choice.targetSceneId)) issues.push(`"${scene.title}"的选择"${choice.text}"指向不存在的节点`);
    });
  });
  const reachable = new Set();
  const visit = (sceneId) => {
    if (!sceneId || reachable.has(sceneId)) return;
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    reachable.add(sceneId);
    if (scene.choices.length) scene.choices.forEach((choice) => visit(choice.targetSceneId));
    else visit(scene.nextSceneId);
  };
  visit(project.startSceneId);
  project.scenes.filter((scene) => !reachable.has(scene.id)).forEach((scene) => issues.push(`"${scene.title}"无法从起点到达`));
  const endings = project.scenes.filter((scene) => !scene.nextSceneId && !scene.choices.length);
  if (!endings.length && project.scenes.length) issues.push("剧情没有结局节点，可能形成无限循环");
  if (showResult) {
    if (issues.length) showToast(`发现 ${issues.length} 个问题：${issues.slice(0, 3).join("；")}${issues.length > 3 ? "……" : ""}`, true);
    else showToast(`分支检查通过：${project.scenes.length} 个节点，${endings.length} 个结局。`);
  }
  return issues;
}

function storyTargets(scene) {
  if (scene.choices.length) return scene.choices.map((choice) => ({ id: choice.targetSceneId, label: choice.text }));
  return scene.nextSceneId ? [{ id: scene.nextSceneId, label: "继续" }] : [];
}

// ─────────────────────────────────────────────
//  剧情树（互动影游 & 短剧通用，带面板拖拽平移）
// ─────────────────────────────────────────────
function buildTreeLayout() {
  const byId = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const depthById = new Map();
  const queue = project.startSceneId ? [{ id: project.startSceneId, depth: 0 }] : [];
  while (queue.length) {
    const current = queue.shift();
    if (!byId.has(current.id)) continue;
    if (depthById.has(current.id) && depthById.get(current.id) <= current.depth) continue;
    depthById.set(current.id, current.depth);
    storyTargets(byId.get(current.id)).forEach((target) => queue.push({ id: target.id, depth: current.depth + 1 }));
  }
  const maxReachableDepth = Math.max(0, ...depthById.values());
  orderedScenes().forEach((scene) => { if (!depthById.has(scene.id)) depthById.set(scene.id, maxReachableDepth + 1); });
  const levels = [];
  orderedScenes().forEach((scene) => {
    const depth = depthById.get(scene.id);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(scene);
  });
  return { byId, depthById, levels };
}

// 短剧：按集数分层布局
function buildSerialTreeLayout() {
  const byId = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const episodes = [...new Set(orderedScenes().map((s) => s.episode || 1))].sort((a, b) => a - b);
  const levels = episodes.map((ep) => orderedScenes()
    .filter((s) => (s.episode || 1) === ep)
    .sort((a, b) => (a.episodeOrder || 0) - (b.episodeOrder || 0)));
  const depthById = new Map();
  levels.forEach((level, depth) => level.forEach((scene) => depthById.set(scene.id, depth)));
  orderedScenes().forEach((scene, index) => { if (!depthById.has(scene.id)) depthById.set(scene.id, index); });
  return { byId, depthById, levels };
}

function openTreeBrowser() {
  syncEditorToScene();
  if (!project.scenes.length) return showToast("当前项目没有剧情节点。", true);
  treeZoom = 1;
  elements.treeModal.hidden = false;
  document.body.classList.add("modal-open");
  $("#treeBrowserTitle").textContent = `${readMetaFromForm().title} · ${currentMode === "serial" ? `${activeEpisode()?.meta.title || "当前集"}结构` : "剧情树"}`;
  $("#treeBrowserMode").textContent = currentMode === "serial" ? "AI 短剧" : "剧情结构";
  renderTreeBrowser();
  setupTreePan();
}

function closeTreeBrowser() {
  if (document.fullscreenElement === elements.treeBrowser) document.exitFullscreen().catch(() => {});
  elements.treeModal.hidden = true;
  document.body.classList.remove("modal-open");
}

// 剧情树面板拖拽平移
function setupTreePan() {
  const viewport = elements.treeViewport;
  if (viewport._panBound) return;
  viewport._panBound = true;

  viewport.addEventListener("mousedown", (e) => {
    // 只响应空白区域（非节点按钮）的左键
    if (e.button !== 0 || e.target.closest(".tree-node")) return;
    treePanState.active = true;
    treePanState.startX = e.clientX;
    treePanState.startY = e.clientY;
    treePanState.scrollLeft = viewport.scrollLeft;
    treePanState.scrollTop = viewport.scrollTop;
    viewport.style.cursor = "grabbing";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!treePanState.active) return;
    const dx = e.clientX - treePanState.startX;
    const dy = e.clientY - treePanState.startY;
    viewport.scrollLeft = treePanState.scrollLeft - dx;
    viewport.scrollTop = treePanState.scrollTop - dy;
  });

  window.addEventListener("mouseup", () => {
    if (!treePanState.active) return;
    treePanState.active = false;
    viewport.style.cursor = "";
  });

  // 触摸平移
  viewport.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || e.target.closest(".tree-node")) return;
    treePanState.active = true;
    treePanState.startX = e.touches[0].clientX;
    treePanState.startY = e.touches[0].clientY;
    treePanState.scrollLeft = viewport.scrollLeft;
    treePanState.scrollTop = viewport.scrollTop;
  }, { passive: true });

  viewport.addEventListener("touchmove", (e) => {
    if (!treePanState.active || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - treePanState.startX;
    const dy = e.touches[0].clientY - treePanState.startY;
    viewport.scrollLeft = treePanState.scrollLeft - dx;
    viewport.scrollTop = treePanState.scrollTop - dy;
  }, { passive: true });

  viewport.addEventListener("touchend", () => { treePanState.active = false; }, { passive: true });

  // 滚轮缩放
  viewport.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setTreeZoom(treeZoom + delta);
    }
  }, { passive: false });
}

function renderTreeBrowser() {
  const layout = currentMode === "serial" ? buildSerialTreeLayout() : buildTreeLayout();
  const { byId, depthById, levels } = layout;

  // 短剧模式节点稍宽，便于显示集数信息
  const nodeWidth = currentMode === "serial" ? 200 : 190;
  const nodeHeight = currentMode === "serial" ? 90 : 78;
  const columnGap = currentMode === "serial" ? 60 : 90;
  const rowGap = 22;
  const padding = 50;

  const maxRows = Math.max(1, ...levels.map((level) => level?.length || 0));
  const canvasWidth = Math.max(720, padding * 2 + levels.length * nodeWidth + Math.max(0, levels.length - 1) * columnGap);
  const canvasHeight = Math.max(520, padding * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap);
  elements.treeCanvas.style.width = `${canvasWidth}px`;
  elements.treeCanvas.style.height = `${canvasHeight}px`;
  elements.treeCanvas.style.zoom = treeZoom;
  elements.treeNodes.innerHTML = "";
  const positions = new Map();

  levels.forEach((levelScenes, depth) => {
    const scenes = levelScenes || [];
    const totalHeight = scenes.length * nodeHeight + Math.max(0, scenes.length - 1) * rowGap;
    const startY = Math.max(padding, (canvasHeight - totalHeight) / 2);
    scenes.forEach((scene, row) => {
      const x = padding + depth * (nodeWidth + columnGap);
      const y = startY + row * (nodeHeight + rowGap);
      positions.set(scene.id, { x, y });
      const node = document.createElement("button");
      const isEnding = !scene.nextSceneId && !scene.choices.length;
      const isSerial = currentMode === "serial";
      node.className = [
        "tree-node",
        scene.id === project.startSceneId ? "start" : "",
        isEnding && !isSerial ? "ending" : "",
        isSerial ? "serial-node" : "",
        scene.id === project.selectedSceneId ? "selected" : "",
      ].filter(Boolean).join(" ");
      node.draggable = true;
      node.title = "拖拽可调整同层节点顺序，双击进入编辑";
      node.style.left = `${x}px`; node.style.top = `${y}px`;
      node.style.width = `${nodeWidth}px`; node.style.height = `${nodeHeight}px`;

      // 节点内容
      const imgDot = scene.imageUrl ? "●" : "○";
      const vidDot = scene.videoUrl ? "●" : "○";
      const assetStatusClass = (scene.imageStatus === "working" || scene.videoStatus === "working") ? " node-generating" : "";

      if (isSerial) {
        const epLabel = `第${scene.episode || 1}集 · ${scene.episodeOrder || 1}`;
        node.innerHTML = `<small class="node-ep-label">${epLabel}</small><strong>${escapeHtml(scene.title)}</strong><span class="node-assets${assetStatusClass}"><span class="asset-icon img">${imgDot}</span>图 <span class="asset-icon vid">${vidDot}</span>视频</span>`;
      } else {
        const label = scene.id === project.startSceneId ? "起点" : isEnding ? "结局" : `${scene.choices.length || 1} 条走向`;
        node.innerHTML = `<small>${label}</small><strong>${escapeHtml(scene.title)}</strong><span class="node-assets${assetStatusClass}"><span class="asset-icon img">${imgDot}</span>图 <span class="asset-icon vid">${vidDot}</span>视频</span>`;
      }

      node.addEventListener("click", () => { project.selectedSceneId = scene.id; saveProject(); renderTreeBrowser(); });
      node.addEventListener("dblclick", () => { project.selectedSceneId = scene.id; saveProject(); closeTreeBrowser(); render(); });
      bindSceneDrag(node, scene.id, "tree", depthById);
      elements.treeNodes.appendChild(node);
    });
  });

  elements.treeEdges.setAttribute("width", canvasWidth);
  elements.treeEdges.setAttribute("height", canvasHeight);
  elements.treeEdges.setAttribute("viewBox", `0 0 ${canvasWidth} ${canvasHeight}`);
  const paths = [];

  project.scenes.forEach((scene) => {
    const source = positions.get(scene.id);
    if (!source) return;
    storyTargets(scene).forEach((target) => {
      const destination = positions.get(target.id);
      if (!destination || !byId.has(target.id)) return;
      const x1 = source.x + nodeWidth, y1 = source.y + nodeHeight / 2;
      const x2 = destination.x, y2 = destination.y + nodeHeight / 2;
      const middle = (x1 + x2) / 2;
      const isSerial = currentMode === "serial";
      paths.push(`<path class="${isSerial ? "serial-edge" : ""}" d="M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}"></path>`);
    });
  });
  elements.treeEdges.innerHTML = paths.join("");

  const endings = project.scenes.filter((scene) => !scene.nextSceneId && !scene.choices.length).length;
  if (currentMode === "serial") {
    $("#treeStats").textContent = `${activeEpisode()?.meta.title || "当前集"} · ${project.scenes.length} 镜头`;
  } else {
    $("#treeStats").textContent = `${project.scenes.length} 节点 · ${endings} 结局`;
  }
  $("#treeZoomResetBtn").textContent = `${Math.round(treeZoom * 100)}%`;
}

function setTreeZoom(value) {
  treeZoom = Math.max(.35, Math.min(2.0, value));
  elements.treeCanvas.style.zoom = treeZoom;
  $("#treeZoomResetBtn").textContent = `${Math.round(treeZoom * 100)}%`;
}

async function toggleTreeFullscreen() {
  try {
    if (document.fullscreenElement === elements.treeBrowser) await document.exitFullscreen();
    else await elements.treeBrowser.requestFullscreen();
  } catch (error) { showToast(`无法切换剧情树全屏：${error.message}`, true); }
}

// ─────────────────────────────────────────────
//  互动影游试玩器
// ─────────────────────────────────────────────
function startStoryPreview(startSceneId = project.startSceneId) {
  syncEditorToScene();
  if (!project.scenes.length) return showToast("请先创建剧情节点。", true);
  const start = project.scenes.find((scene) => scene.id === startSceneId);
  if (!start) return showToast("试玩起点不存在。", true);
  playerState = { sceneId: start.id, history: [], startSceneId: start.id };
  const meta = readMetaFromForm();
  $("#playerProjectTitle").textContent = meta.title;
  applyStoryPlayerAspect(meta.aspectRatio);
  elements.storyModal.hidden = false;
  document.body.classList.add("modal-open");
  renderStoryPlayer();
}

function applyStoryPlayerAspect(aspectRatio) {
  const aspect = ["16:9", "9:16", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9";
  elements.storyPlayer.dataset.aspect = aspect;
  elements.storyPlayer.style.setProperty("--player-aspect", aspect.replace(":", " / "));
  elements.playerStage.setAttribute("aria-label", `${aspect} 画幅预览`);
}

function closeStoryPreview() {
  const video = elements.playerStage.querySelector("video");
  if (video) video.pause();
  if (document.fullscreenElement === elements.storyPlayer) document.exitFullscreen().catch(() => {});
  elements.storyModal.hidden = true;
  document.body.classList.remove("modal-open");
}

async function toggleStoryFullscreen() {
  try {
    if (document.fullscreenElement === elements.storyPlayer) await document.exitFullscreen();
    else await elements.storyPlayer.requestFullscreen();
  } catch (error) { showToast(`无法切换全屏：${error.message}`, true); }
}

function updateFullscreenButton() {
  const btn = $("#fullscreenStoryBtn");
  if (btn) btn.textContent = document.fullscreenElement === elements.storyPlayer ? "退出全屏" : "进入全屏";
  const sBtn = $("#fullscreenSerialBtn");
  if (sBtn) sBtn.textContent = document.fullscreenElement === elements.serialPlayer ? "退出全屏" : "全屏";
}

function goToPlayerScene(targetSceneId, choiceText = "") {
  const target = project.scenes.find((scene) => scene.id === targetSceneId);
  if (!target) return showToast("这个选择尚未连接到有效剧情节点。", true);
  playerState.history.push({ sceneId: playerState.sceneId, choiceText });
  playerState.sceneId = target.id;
  renderStoryPlayer();
}

function renderStoryPlayer() {
  const scene = project.scenes.find((item) => item.id === playerState.sceneId);
  if (!scene) return closeStoryPreview();
  applyStoryPlayerAspect(readMetaFromForm().aspectRatio);
  const index = project.scenes.findIndex((item) => item.id === scene.id);
  $("#playerProgress").textContent = `节点 ${String(index + 1).padStart(2, "0")} · 已做出 ${playerState.history.filter((item) => item.choiceText).length} 次选择`;
  $("#playerSceneTitle").textContent = scene.title;
  $("#playerAction").textContent = scene.action || "";
  $("#playerDialogue").textContent = scene.dialogue || "";
  $("#playerDialogue").hidden = !scene.dialogue;
  elements.playerStage.innerHTML = "";
  const videoUrl = scene.videoLocalUrl || (scene.videoUrl ? proxyMediaUrl(scene.videoUrl) : "");
  const imageUrl = scene.imageLocalUrl || (scene.imageUrl ? proxyMediaUrl(scene.imageUrl) : "");
  if (videoUrl) {
    const frame = document.createElement("div"); frame.className = "player-media-frame";
    const video = document.createElement("video");
    video.src = videoUrl; video.controls = true; video.autoplay = true; video.playsInline = true;
    frame.appendChild(video); elements.playerStage.appendChild(frame);
  } else if (imageUrl) {
    const frame = document.createElement("div"); frame.className = "player-media-frame";
    const image = document.createElement("img"); image.src = imageUrl; image.alt = scene.title;
    frame.appendChild(image); elements.playerStage.appendChild(frame);
  } else {
    elements.playerStage.innerHTML = `<div class="player-no-media"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(scene.title)}</strong><small>该节点尚未生成影音素材</small></div>`;
  }
  const choices = $("#playerChoices"); choices.innerHTML = "";
  if (scene.choices.length) {
    scene.choices.forEach((choice) => {
      const button = document.createElement("button"); button.className = "player-choice";
      button.innerHTML = `<strong></strong>${choice.effect ? `<small>${escapeHtml(choice.effect)}</small>` : ""}`;
      button.querySelector("strong").textContent = choice.text;
      button.addEventListener("click", () => goToPlayerScene(choice.targetSceneId, choice.text));
      choices.appendChild(button);
    });
  } else if (scene.nextSceneId) {
    const next = project.scenes.find((item) => item.id === scene.nextSceneId);
    const button = document.createElement("button"); button.className = "player-choice continue";
    button.textContent = `继续：${next?.title || "下一镜头"}`;
    button.addEventListener("click", () => goToPlayerScene(scene.nextSceneId));
    choices.appendChild(button);
  } else {
    const ending = document.createElement("div"); ending.className = "player-ending";
    ending.innerHTML = `<strong>结局已达成</strong><span>本次经历 ${playerState.history.length + 1} 个剧情节点</span>`;
    choices.appendChild(ending);
  }
}

// ─────────────────────────────────────────────
//  AI短剧线性播放器
// ─────────────────────────────────────────────
function serialOrderedScenes() {
  return window.FrameForgeEpisodeModel.allScenes(project);
}

function updateDialogueTiming(scene = selectedScene()) {
  const hint = $("#dialogueTimingHint");
  if (!hint || !scene) return;
  const count = spokenCharacterCount(elements.sceneDialogue?.value ?? scene.dialogue);
  const duration = Number(elements.sceneDuration?.value || scene.duration || 8);
  const budget = dialogueBudget(duration);
  const overflow = count > budget;
  hint.textContent = overflow
    ? `当前约 ${count} 字，${duration} 秒建议不超过 ${budget} 字；可继续生成，但语速可能偏快。`
    : `当前约 ${count}/${budget} 字，按清晰语速约每秒 3 字估算。`;
  hint.classList.toggle("warning", overflow);
}

function startSerialPreview(startIndex = 0) {
  syncEditorToScene();
  syncEpisodeFromForm();
  if (!serialOrderedScenes().length) return showToast("请先创建短剧镜头。", true);
  clearSerialAutoPlay();
  serialState = { index: startIndex, autoPlay: false, autoTimer: null };
  const meta = readMetaFromForm();
  $("#serialPlayerTitle").textContent = meta.title;
  applySerialPlayerAspect(meta.aspectRatio);
  elements.serialModal.hidden = false;
  document.body.classList.add("modal-open");
  renderSerialPlayer();
}

function applySerialPlayerAspect(aspectRatio) {
  const aspect = ["16:9", "9:16", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9";
  elements.serialPlayer.dataset.aspect = aspect;
  elements.serialPlayer.style.setProperty("--player-aspect", aspect.replace(":", " / "));
}

function closeSerialPreview() {
  clearSerialAutoPlay();
  const video = elements.serialStage.querySelector("video");
  if (video) video.pause();
  if (document.fullscreenElement === elements.serialPlayer) document.exitFullscreen().catch(() => {});
  elements.serialModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function clearSerialAutoPlay() {
  if (serialState.autoTimer) { clearTimeout(serialState.autoTimer); serialState.autoTimer = null; }
  serialState.autoPlay = false;
  const btn = $("#serialAutoPlayBtn");
  if (btn) btn.textContent = "▶ 自动播放";
}

function renderSerialPlayer() {
  const scenes = serialOrderedScenes();
  if (!scenes.length) return closeSerialPreview();
  const index = Math.max(0, Math.min(serialState.index, scenes.length - 1));
  serialState.index = index;
  const scene = scenes[index];

  // 进度
  const ep = scene.episode || 1;
  const epOrder = scene.episodeOrder || (index + 1);
  const totalEps = new Set(scenes.map((s) => s.episode || 1)).size;
  $("#serialEpTag").textContent = `第${ep}集 · 第${epOrder}镜`;
  $("#serialProgress").textContent = `${index + 1} / ${scenes.length}`;
  $("#serialSceneTitle").textContent = scene.title;
  $("#serialAction").textContent = scene.action || "";
  $("#serialDialogue").textContent = scene.dialogue || "";
  $("#serialDialogue").hidden = !scene.dialogue;

  // 导航按钮
  $("#serialPrevBtn").disabled = index <= 0;
  $("#serialNextBtn").disabled = index >= scenes.length - 1;

  // 媒体
  elements.serialStage.innerHTML = "";
  const videoUrl = scene.videoLocalUrl || (scene.videoUrl ? proxyMediaUrl(scene.videoUrl) : "");
  const imageUrl = scene.imageLocalUrl || (scene.imageUrl ? proxyMediaUrl(scene.imageUrl) : "");
  if (videoUrl) {
    const frame = document.createElement("div"); frame.className = "player-media-frame";
    const video = document.createElement("video");
    video.src = videoUrl; video.controls = true; video.autoplay = serialState.autoPlay; video.playsInline = true;
    // 自动播放：视频结束后自动进入下一镜
    if (serialState.autoPlay) {
      video.addEventListener("ended", () => {
        if (serialState.autoPlay && index < scenes.length - 1) {
          serialState.index += 1; renderSerialPlayer();
        } else { clearSerialAutoPlay(); }
      }, { once: true });
    }
    frame.appendChild(video); elements.serialStage.appendChild(frame);
  } else if (imageUrl) {
    const frame = document.createElement("div"); frame.className = "player-media-frame";
    const image = document.createElement("img"); image.src = imageUrl; image.alt = scene.title;
    frame.appendChild(image); elements.serialStage.appendChild(frame);
    // 自动播放：图片按时长自动前进
    if (serialState.autoPlay && index < scenes.length - 1) {
      serialState.autoTimer = setTimeout(() => {
        if (serialState.autoPlay) { serialState.index += 1; renderSerialPlayer(); }
      }, (scene.duration || 8) * 1000);
    }
  } else {
    elements.serialStage.innerHTML = `<div class="player-no-media"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(scene.title)}</strong><small>该镜头尚未生成影音素材</small></div>`;
    if (serialState.autoPlay && index < scenes.length - 1) {
      serialState.autoTimer = setTimeout(() => {
        if (serialState.autoPlay) { serialState.index += 1; renderSerialPlayer(); }
      }, 3000);
    }
  }
}

function toggleSerialAutoPlay() {
  if (serialState.autoPlay) { clearSerialAutoPlay(); }
  else {
    serialState.autoPlay = true;
    $("#serialAutoPlayBtn").textContent = "⏸ 暂停";
    renderSerialPlayer();
  }
}

// ─────────────────────────────────────────────
//  媒体渲染（编辑器）
// ─────────────────────────────────────────────
function renderMedia(scene) {
  if (scene.imageStatus === "working") elements.imageCard.innerHTML = `<div class="media-loading">图片供应商正在生成关键帧<small>任务 ${escapeHtml(scene.imagePredictionId || "正在提交")}</small><button class="button danger ghost media-stop" data-kind="image">停止等待</button></div>`;
  else if (scene.imageStatus === "paused" && scene.imagePredictionId) elements.imageCard.innerHTML = `<div class="media-paused"><strong>关键帧查询已暂停</strong><span>供应商任务可能仍在后台运行</span><button class="button primary media-resume" data-kind="image">继续查询结果</button></div>`;
  else if (scene.imageUrl || scene.imageLocalUrl) elements.imageCard.innerHTML = `<div class="media-content"><img alt="生成的镜头关键帧"><div class="media-actions"><span class="media-save-state"></span><a class="media-link media-open" target="_blank" rel="noopener">查看原图</a><a class="media-link media-download">下载图片</a><button class="button ghost media-save">保存到项目</button></div></div>`;
  else elements.imageCard.innerHTML = '<div class="media-placeholder">关键帧将在这里出现</div>';
  elements.imageCard.querySelector(".media-stop")?.addEventListener("click", () => stopTask(scene.id, "image"));
  elements.imageCard.querySelector(".media-resume")?.addEventListener("click", () => resumeTask(scene, "image"));
  if (scene.imageUrl || scene.imageLocalUrl) {
    const displayUrl = scene.imageLocalUrl || proxyMediaUrl(scene.imageUrl);
    elements.imageCard.querySelector("img").src = displayUrl;
    elements.imageCard.querySelector("img").addEventListener("error", () => showToast("图片预览加载失败，请保存到项目后重试。", true), { once: true });
    elements.imageCard.querySelector(".media-open").href = displayUrl;
    elements.imageCard.querySelector(".media-open").addEventListener("click", (event) => {
      event.preventDefault(); openMediaPreview("image", displayUrl, `${scene.title} · 关键帧`);
    });
    elements.imageCard.querySelector(".media-download").href = downloadMediaUrl(scene.imageUrl || scene.imageLocalUrl, `${scene.title}-关键帧`);
    elements.imageCard.querySelector(".media-download").download = "";
    const state = elements.imageCard.querySelector(".media-save-state");
    state.textContent = scene.imageLocalUrl ? "已保存" : "";
    state.className = `media-save-state${scene.imageLocalUrl ? " saved" : ""}`;
    const saveButton = elements.imageCard.querySelector(".media-save");
    saveButton.hidden = Boolean(scene.imageLocalUrl);
    saveButton.addEventListener("click", () => saveAsset(scene, "image", saveButton));
  }
  if (scene.videoStatus === "working") elements.videoCard.innerHTML = `<div class="media-loading">视频供应商正在生成视频<small>任务 ${escapeHtml(scene.videoPredictionId || "正在提交")}</small><button class="button danger ghost media-stop" data-kind="video">停止等待</button></div>`;
  else if (scene.videoStatus === "paused" && scene.videoPredictionId) elements.videoCard.innerHTML = `<div class="media-paused"><strong>视频查询已暂停</strong><span>供应商任务可能仍在后台运行</span><button class="button primary media-resume" data-kind="video">继续查询结果</button></div>`;
  else if (scene.videoUrl || scene.videoLocalUrl) elements.videoCard.innerHTML = `<div class="media-content"><video controls playsinline preload="metadata"></video><div class="media-actions"><span class="media-save-state"></span><a class="media-link media-open" target="_blank" rel="noopener">查看视频</a><a class="media-link media-download">下载视频</a><button class="button ghost media-save">保存到项目</button></div></div>`;
  else elements.videoCard.innerHTML = '<div class="media-placeholder">视频将在这里出现</div>';
  elements.videoCard.querySelector(".media-stop")?.addEventListener("click", () => stopTask(scene.id, "video"));
  elements.videoCard.querySelector(".media-resume")?.addEventListener("click", () => resumeTask(scene, "video"));
  if (scene.videoUrl || scene.videoLocalUrl) {
    const displayUrl = scene.videoLocalUrl || proxyMediaUrl(scene.videoUrl);
    elements.videoCard.querySelector("video").src = displayUrl;
    elements.videoCard.querySelector("video").addEventListener("error", () => showToast("视频预览加载失败，请点击保存到项目后重试。", true), { once: true });
    elements.videoCard.querySelector(".media-open").href = displayUrl;
    elements.videoCard.querySelector(".media-open").addEventListener("click", (event) => {
      event.preventDefault(); openMediaPreview("video", displayUrl, `${scene.title} · 视频`);
    });
    elements.videoCard.querySelector(".media-download").href = downloadMediaUrl(scene.videoUrl || scene.videoLocalUrl, `${scene.title}-视频`);
    elements.videoCard.querySelector(".media-download").download = "";
    const state = elements.videoCard.querySelector(".media-save-state");
    state.textContent = scene.videoLocalUrl ? "已保存" : "";
    state.className = `media-save-state${scene.videoLocalUrl ? " saved" : ""}`;
    const saveButton = elements.videoCard.querySelector(".media-save");
    saveButton.hidden = Boolean(scene.videoLocalUrl);
    saveButton.addEventListener("click", () => saveAsset(scene, "video", saveButton));
  }
}

function openMediaPreview(kind, url, title) {
  closeMediaPreview();
  $("#mediaPreviewTitle").textContent = title || "素材预览";
  $("#mediaPreviewExternal").href = url;
  if (kind === "video") {
    const video = document.createElement("video");
    video.src = url; video.controls = true; video.autoplay = true; video.playsInline = true;
    elements.mediaPreviewStage.appendChild(video);
  } else {
    const image = document.createElement("img");
    image.src = url; image.alt = title || "素材预览";
    elements.mediaPreviewStage.appendChild(image);
  }
  elements.mediaPreviewModal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeMediaPreview() {
  if (!elements.mediaPreviewModal) return;
  const video = elements.mediaPreviewStage.querySelector("video");
  if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
  if (document.fullscreenElement && elements.mediaPreviewModal.contains(document.fullscreenElement)) {
    document.exitFullscreen().catch(() => {});
  }
  elements.mediaPreviewStage.innerHTML = "";
  elements.mediaPreviewModal.hidden = true;
  if (elements.treeModal.hidden && elements.storyModal.hidden && elements.serialModal.hidden) {
    document.body.classList.remove("modal-open");
  }
}

function proxyMediaUrl(url) {
  if (!url || url.startsWith("/projects/")) return url;
  return `/api/media?url=${encodeURIComponent(url)}`;
}
function downloadMediaUrl(url, filename) {
  if (url?.startsWith("/projects/")) return url;
  return `/api/media?download=1&filename=${encodeURIComponent(filename)}&url=${encodeURIComponent(url)}`;
}

async function saveAsset(scene, kind, button = null, quiet = false) {
  const remoteUrl = kind === "image" ? scene.imageUrl : scene.videoUrl;
  if (!remoteUrl) return null;
  if (button) { button.disabled = true; button.textContent = "保存中…"; }
  try {
    const result = await requestJson("/api/save-asset", { method: "POST", body: JSON.stringify({
      url: remoteUrl, kind, project_title: readMetaFromForm().title, scene_id: scene.id,
    }) });
    scene[`${kind}LocalUrl`] = result.localUrl;
    saveProject();
    if (!quiet) showToast(`${kind === "image" ? "图片" : "视频"}已保存到 ${result.path}`);
    return result.localUrl;
  } catch (error) {
    if (!quiet) showToast(error.message, true);
    return null;
  } finally {
    if (button) { button.disabled = false; button.textContent = "保存到项目"; }
    if (project.selectedSceneId === scene.id) renderMedia(scene);
  }
}

// ─────────────────────────────────────────────
//  编辑器同步
// ─────────────────────────────────────────────
function syncEditorToScene() {
  const scene = selectedScene();
  if (!scene || elements.sceneEditor.hidden) return;
  const nextValues = {
    title: elements.sceneTitle.value.trim() || "未命名镜头",
    shot: elements.sceneShot.value,
    duration: Number(elements.sceneDuration.value),
    action: elements.sceneAction.value.trim(),
    dialogue: elements.sceneDialogue.value.trim(),
    referenceSceneId: elements.sceneReference.value,
    imagePrompt: elements.sceneImagePrompt.value.trim(),
  };
  if (currentMode === "interactive") {
    nextValues.nextSceneId = elements.sceneNext.value;
  } else {
    const orderInput = $("#sceneEpisodeOrder");
    nextValues.episode = (activeEpisode()?.order || 0) + 1;
    if (orderInput) nextValues.episodeOrder = Number(orderInput.value) || 1;
    if (elements.sceneTransition) nextValues.transition = elements.sceneTransition.value || "match";
    if (elements.sceneEntryState) nextValues.entryState = elements.sceneEntryState.value.trim();
    if (elements.sceneExitState) nextValues.exitState = elements.sceneExitState.value.trim();
  }
  nextValues.videoPrompt = mergeVideoNarrativeContext(elements.sceneVideoPrompt.value.trim(), nextValues);
  Object.assign(scene, nextValues);
  elements.sceneVideoPrompt.value = scene.videoPrompt;
  updateDialogueTiming(scene);
  saveProject(); renderSceneList();
}

function render() {
  if (currentMode === "serial") renderEpisodeList();
  renderSceneList();
  renderEditor();
  if (currentMode === "serial") updateSerialEstimate();
}
function renderTaskResult(scene) {
  renderSceneList();
  if (project.selectedSceneId === scene.id) renderEditor();
}

// ─────────────────────────────────────────────
//  HTTP / 任务控制
// ─────────────────────────────────────────────
async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detailValue = typeof data.details === "string"
      ? data.details
      : data.details?.message || data.details?.detail || data.details?.error?.message || "";
    const details = detailValue ? ` ${detailValue}` : "";
    throw new Error((data.error || `请求失败 (${response.status})`) + details);
  }
  return data;
}

function taskKey(sceneId, kind) { return `${sceneId}:${kind}`; }
function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("任务已停止", "AbortError"));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("任务已停止", "AbortError")); }, { once: true });
  });
}
function createTask(scene, kind) {
  const key = taskKey(scene.id, kind);
  activeTasks.get(key)?.controller.abort();
  const task = { controller: new AbortController(), token: `${Date.now()}-${Math.random()}` };
  activeTasks.set(key, task);
  return task;
}
function isTaskActive(scene, kind, task) {
  return !task.controller.signal.aborted && activeTasks.get(taskKey(scene.id, kind))?.token === task.token;
}
function stopTask(sceneId, kind) {
  const scene = project.scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  const key = taskKey(sceneId, kind);
  activeTasks.get(key)?.controller.abort();
  activeTasks.delete(key);
  const predictionId = scene[`${kind}PredictionId`];
  scene[`${kind}Status`] = predictionId ? "paused" : "idle";
  saveProject();
  if (project.selectedSceneId === sceneId) renderEditor();
  renderSceneList();
  showToast(predictionId ? "已停止本地等待。供应商任务可能仍在运行，可稍后继续查询。" : "已停止提交请求。");
}

async function resetAsset(kind) {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene) return;
  const label = kind === "image" ? "关键帧及其视频" : "视频";
  const status = scene[`${kind}Status`];
  const warning = status === "working"
    ? `当前${kind === "image" ? "关键帧" : "视频"}仍在提交或查询。清除只会停止本地请求，供应商后台任务可能继续运行并产生费用。\n\n确定清除${label}并允许重新提交吗？`
    : `确定清除当前镜头的${label}、任务 ID和本地文件吗？`;
  if (!confirm(warning)) return;
  const kinds = kind === "image" ? ["image", "video"] : ["video"];
  kinds.forEach((item) => {
    const key = taskKey(scene.id, item);
    activeTasks.get(key)?.controller.abort();
    activeTasks.delete(key);
    scene[`${item}Status`] = "idle"; scene[`${item}PredictionId`] = "";
    scene[`${item}Url`] = ""; scene[`${item}LocalUrl`] = "";
  });
  saveProject(); renderTaskResult(scene);
  const failures = [];
  for (const item of kinds) {
    try { await requestJson("/api/delete-asset", { method: "POST", body: JSON.stringify({ kind: item, project_title: readMetaFromForm().title, scene_id: scene.id }) }); }
    catch (error) { failures.push(error.message); }
  }
  try { await requestJson("/api/save-project", { method: "POST", body: JSON.stringify({ project }) }); }
  catch (error) { failures.push(`项目文件同步失败：${error.message}`); }
  if (failures.length) showToast(`生成状态已清除，但本地文件删除失败：${failures.join("；")}`, true);
  else showToast(`${label}已清除，现在可以重新提交生成。`);
}

function predictionId(result) {
  const id = result?.data?.id;
  if (!id) throw new Error("模型供应商未返回任务 ID。");
  return id;
}

async function pollPrediction(id, onProgress, signal, kind) {
  const deadline = Date.now() + 20 * 60 * 1000;
  let consecutiveErrors = 0;
  saveProviderSecrets();
  const provider = providerSettings(kind);
  while (Date.now() < deadline) {
    let result;
    try {
      result = await requestJson(`/api/predictions/${encodeURIComponent(id)}`, {
        signal,
        headers: { "X-Provider-Base-Url": provider.baseUrl, "X-Provider-Api-Key": provider.apiKey, "X-Provider-Kind": kind },
      });
      consecutiveErrors = 0;
    } catch (error) {
      if (error.name === "AbortError" || signal?.aborted) throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 8) throw new Error(`任务查询连续失败 ${consecutiveErrors} 次：${error.message}`);
      onProgress?.("reconnecting");
      await abortableDelay(Math.min(20000, 1500 * (2 ** (consecutiveErrors - 1))), signal);
      continue;
    }
    const status = result?.data?.status;
    onProgress?.(status);
    if (["completed", "succeeded"].includes(status)) {
      const output = result?.data?.outputs?.[0];
      if (!output) throw new Error("生成已完成，但没有返回素材 URL。");
      return output;
    }
    if (["failed", "cancelled", "canceled"].includes(status)) throw new Error(result?.data?.error || "生成任务失败。");
    await abortableDelay(2500, signal);
  }
  throw new Error("生成等待超过 20 分钟，请稍后查看任务状态。");
}

function imageSizeForAspect(aspect) {
  if (aspect === "9:16") return "1024x1536";
  if (aspect === "1:1") return "1024x1024";
  return "1536x1024";
}

async function generateImage() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene?.imagePrompt) return showToast("请先填写关键帧提示词。", true);
  const reference = findSceneAcrossProject(scene.referenceSceneId);
  if (scene.referenceSceneId && !reference?.imageUrl && !reference?.imageLocalUrl) return showToast("所选角色参考镜头尚未生成关键帧。", true);
  const task = createTask(scene, "image");
  saveProviderSecrets();
  const provider = providerSettings("image");
  scene.imageStatus = "working"; scene.imagePredictionId = ""; saveProject(); render();
  try {
    const started = await requestJson("/api/generate-image", { method: "POST", body: JSON.stringify({
      prompt: reference ? `将参考图仅用于保持角色身份一致：严格保留同一张脸、年龄、发型、肤色、体型和服装设计。不要照搬参考图的背景、姿势、动作或构图，必须完全依据当前镜头重新构图：\n${scene.imagePrompt}` : scene.imagePrompt,
      reference_image_url: reference?.imageUrl || reference?.imageLocalUrl || "",
      quality: $("#imageQuality").value, output_format: $("#imageFormat").value,
      size: imageSizeForAspect(project.meta.aspectRatio), moderation: "low",
      image_base_url: provider.baseUrl, image_api_key: provider.apiKey,
      image_model: project.meta.imageModel, image_edit_model: project.meta.imageEditModel,
    }), signal: task.controller.signal });
    if (!isTaskActive(scene, "image", task)) throw new DOMException("任务已清除", "AbortError");
    scene.imagePredictionId = predictionId(started); saveProject();
    if (project.selectedSceneId === scene.id) renderMedia(scene);
    scene.imageUrl = await pollPrediction(scene.imagePredictionId, null, task.controller.signal, "image");
    if (!isTaskActive(scene, "image", task)) throw new DOMException("任务已清除", "AbortError");
    scene.imageStatus = "completed"; scene.imagePredictionId = "";
    scene.imageLocalUrl = ""; scene.videoUrl = ""; scene.videoLocalUrl = ""; scene.videoStatus = "idle";
    await saveAsset(scene, "image", null, true);
    showToast(scene.imageLocalUrl ? "关键帧生成完成并已保存到项目。" : "关键帧生成完成，可使用保存按钮落盘。");
  } catch (error) {
    if (error.name !== "AbortError") { scene.imageStatus = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(taskKey(scene.id, "image"))?.token === task.token) activeTasks.delete(taskKey(scene.id, "image"));
    saveProject(); renderTaskResult(scene);
  }
}

async function generateVideo() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene?.imageUrl) return showToast("请先为当前镜头生成关键帧。", true);
  if (!scene.videoPrompt) return showToast("请先填写运镜提示词。", true);
  const dialogueLength = spokenCharacterCount(scene.dialogue);
  const budget = dialogueBudget(scene.duration);
  if (dialogueLength > budget) {
    const recommended = recommendedDialogueDuration(scene.dialogue);
    const advice = dialogueLength <= dialogueBudget(15) ? `建议改为 ${recommended} 秒` : "建议把对白拆到多个镜头";
    showToast(`对白约 ${dialogueLength} 字，当前 ${scene.duration} 秒可能语速偏快；${advice}，本次仍将继续生成。`);
  }
  const task = createTask(scene, "video");
  saveProviderSecrets();
  const provider = providerSettings("video");
  scene.videoStatus = "working"; scene.videoPredictionId = ""; saveProject(); render();
  try {
    const started = await requestJson("/api/generate-video", { method: "POST", body: JSON.stringify({
      prompt: scene.videoPrompt, image_url: scene.imageUrl, duration: scene.duration,
      resolution: $("#videoResolution").value, aspect_ratio: project.meta.aspectRatio,
      video_base_url: provider.baseUrl, video_api_key: provider.apiKey, video_model: project.meta.videoModel,
    }), signal: task.controller.signal });
    if (!isTaskActive(scene, "video", task)) throw new DOMException("任务已清除", "AbortError");
    scene.videoPredictionId = predictionId(started); saveProject();
    if (project.selectedSceneId === scene.id) renderMedia(scene);
    scene.videoUrl = await pollPrediction(scene.videoPredictionId, null, task.controller.signal, "video");
    if (!isTaskActive(scene, "video", task)) throw new DOMException("任务已清除", "AbortError");
    scene.videoStatus = "completed"; scene.videoPredictionId = ""; scene.videoLocalUrl = "";
    await saveAsset(scene, "video", null, true);
    showToast(scene.videoLocalUrl ? "视频生成完成并已保存到项目。" : "视频生成完成，可使用保存按钮落盘。");
  } catch (error) {
    if (error.name !== "AbortError") { scene.videoStatus = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(taskKey(scene.id, "video"))?.token === task.token) activeTasks.delete(taskKey(scene.id, "video"));
    saveProject(); renderTaskResult(scene);
  }
}

async function resumeTask(scene, kind) {
  const predictionIdValue = scene[`${kind}PredictionId`];
  if (!predictionIdValue) return showToast("没有可继续查询的任务 ID。", true);
  const task = createTask(scene, kind);
  scene[`${kind}Status`] = "working"; saveProject(); render();
  try {
    const output = await pollPrediction(predictionIdValue, null, task.controller.signal, kind);
    scene[`${kind}Url`] = output; scene[`${kind}LocalUrl`] = "";
    scene[`${kind}Status`] = "completed"; scene[`${kind}PredictionId`] = "";
    if (kind === "image") { scene.videoUrl = ""; scene.videoLocalUrl = ""; scene.videoStatus = "idle"; }
    await saveAsset(scene, kind, null, true);
    showToast(`${kind === "image" ? "关键帧" : "视频"}任务已完成并恢复。`);
  } catch (error) {
    if (error.name !== "AbortError") { scene[`${kind}Status`] = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(taskKey(scene.id, kind))?.token === task.token) activeTasks.delete(taskKey(scene.id, kind));
    saveProject(); renderTaskResult(scene);
  }
}

// ─────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────
function toggleButton(selector, disabled, text) {
  const button = $(selector); button.disabled = disabled; button.textContent = text;
}
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${isError ? " error" : ""}`;
  toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 5000);
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function exportProject() {
  syncEditorToScene(); syncEpisodeFromForm(); saveProject();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${project.meta.title || "narrative-forge-project"}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
async function persistProject() {
  syncEditorToScene(); syncEpisodeFromForm(); saveProject();
  const button = $("#saveProjectBtn");
  button.disabled = true; button.textContent = "保存中…";
  try {
    const result = await requestJson("/api/save-project", { method: "POST", body: JSON.stringify({ project }) });
    showToast(`项目已保存到 ${result.path}`);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.textContent = "保存项目"; }
}
async function importProject(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const hasScenes = Array.isArray(parsed?.scenes) || Array.isArray(parsed?.interactive?.scenes) || Array.isArray(parsed?.episodes);
    if (!parsed?.meta || !hasScenes) throw new Error("不是有效的 Narrative Forge 项目文件。");
    project = normalizeProject(parsed);
    project.selectedSceneId = project.selectedSceneId || project.scenes[0]?.id || null;
    applyMetaToForm(); saveProject(); render(); showToast("项目已导入。");
  } catch (error) { showToast(error.message, true); }
}
async function openAssetFolder(sceneId = "") {
  try {
    const result = await requestJson("/api/open-folder", { method: "POST", body: JSON.stringify({ project_title: readMetaFromForm().title, scene_id: sceneId }) });
    showToast(`已打开 ${result.path}`);
  } catch (error) { showToast(error.message, true); }
}

// ─────────────────────────────────────────────
//  事件绑定
// ─────────────────────────────────────────────
function bindEvents() {
  // 模式切换
  document.querySelectorAll(".mode-tab").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  // 草案生成
  $("#draftBtn").addEventListener("click", generateStoryDraft);
  $("#localDraftBtn").addEventListener("click", buildLocalDraft);
  $("#testTextProviderBtn").addEventListener("click", testTextProvider);

  // 剧情树
  $("#browseTreeBtn").addEventListener("click", openTreeBrowser);
  $("#closeTreeBtn").addEventListener("click", closeTreeBrowser);
  $(".tree-backdrop").addEventListener("click", closeTreeBrowser);
  $("#treeZoomOutBtn").addEventListener("click", () => setTreeZoom(treeZoom - .15));
  $("#treeZoomInBtn").addEventListener("click", () => setTreeZoom(treeZoom + .15));
  $("#treeZoomResetBtn").addEventListener("click", () => setTreeZoom(1));
  $("#treeFullscreenBtn").addEventListener("click", toggleTreeFullscreen);

  // 分镜列表
  $("#addSceneBtn").addEventListener("click", () => {
    syncEditorToScene();
    const previous = selectedScene();
    const scene = createScene();
    scene.imagePrompt = composeImagePrompt(scene); scene.videoPrompt = composeVideoPrompt(scene);
    if (previous && currentMode === "interactive" && !previous.nextSceneId && !previous.choices.length) previous.nextSceneId = scene.id;
    project.scenes.push(scene); project.selectedSceneId = scene.id; saveProject(); render();
  });
  // 短剧模式添加镜头
  $("#addSerialSceneBtn").addEventListener("click", () => {
    syncEditorToScene();
    const ep = (activeEpisode()?.order || 0) + 1;
    const maxOrder = project.scenes.length ? Math.max(...project.scenes.map((s) => s.episodeOrder || 0)) : 0;
    const previous = selectedScene();
    const scene = createScene({ episode: ep, episodeOrder: maxOrder + 1 });
    scene.imagePrompt = composeImagePrompt(scene); scene.videoPrompt = composeVideoPrompt(scene);
    if (previous) { previous.nextSceneId = scene.id; }
    project.scenes.push(scene); project.selectedSceneId = scene.id; saveProject(); render();
  });
  $("#serialEpisodeFilter").addEventListener("change", (event) => selectEpisode(event.target.value));
  $("#addEpisodeBtn").addEventListener("click", addEpisode);
  $("#deleteEpisodeBtn").addEventListener("click", deleteEpisode);
  $("#syncEpisodesBtn").addEventListener("click", syncEpisodesToPlan);
  $("#rebuildTransitionsBtn")?.addEventListener("click", () => { syncEditorToScene(); rebuildSerialTransitions(true, true, true); });

  // 删除镜头
  $("#deleteSceneBtn").addEventListener("click", () => {
    const index = project.scenes.findIndex((scene) => scene.id === project.selectedSceneId);
    if (index < 0 || !confirm("删除当前镜头及其素材链接？")) return;
    const deletedId = project.scenes[index].id;
    project.scenes.splice(index, 1);
    normalizeSceneOrder();
    if (currentMode === "serial") rebuildSerialTransitions(false, true);
    project.scenes.forEach((scene) => {
      if (scene.nextSceneId === deletedId) scene.nextSceneId = "";
      scene.choices.forEach((choice) => { if (choice.targetSceneId === deletedId) choice.targetSceneId = ""; });
    });
    if (project.startSceneId === deletedId) project.startSceneId = project.scenes[0]?.id || null;
    const referenceOwners = currentMode === "serial" ? serialSceneEntries().map((entry) => entry.scene) : project.scenes;
    referenceOwners.forEach((scene) => {
      if (scene.referenceSceneId === deletedId) {
        const sameEpisode = currentMode === "serial"
          ? project.episodes.find((episode) => episode.scenes.some((candidate) => candidate.id === scene.id))
          : null;
        scene.referenceSceneId = scene.id === sameEpisode?.startSceneId || scene.id === project.startSceneId
          ? ""
          : (sameEpisode?.startSceneId || project.startSceneId || "");
      }
    });
    project.selectedSceneId = project.scenes[Math.min(index, project.scenes.length - 1)]?.id || null;
    saveProject(); render();
  });

  // 互动影游专属
  $("#addChoiceBtn").addEventListener("click", addChoice);
  elements.sceneNext.addEventListener("change", syncEditorToScene);
  $("#setStartSceneBtn").addEventListener("click", () => {
    const scene = selectedScene(); if (!scene) return;
    project.startSceneId = scene.id; saveProject(); renderSceneList(); showToast(`"${scene.title}"已设为剧情起点。`);
  });
  $("#validateStoryBtn").addEventListener("click", () => validateStoryGraph(true));
  $("#previewFromSceneBtn").addEventListener("click", () => startStoryPreview(project.selectedSceneId));

  // 互动影游试玩
  $("#previewStoryBtn").addEventListener("click", () => startStoryPreview(project.startSceneId));
  $("#restartStoryBtn").addEventListener("click", () => {
    playerState = { sceneId: playerState.startSceneId, history: [], startSceneId: playerState.startSceneId };
    renderStoryPlayer();
  });
  $("#fullscreenStoryBtn").addEventListener("click", toggleStoryFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  $("#closeStoryBtn").addEventListener("click", closeStoryPreview);
  $(".story-backdrop").addEventListener("click", closeStoryPreview);

  // AI短剧预览
  $("#previewSerialBtn").addEventListener("click", () => startSerialPreview(0));
  $("#serialPrevBtn").addEventListener("click", () => {
    clearSerialAutoPlay();
    if (serialState.index > 0) { serialState.index -= 1; renderSerialPlayer(); }
  });
  $("#serialNextBtn").addEventListener("click", () => {
    clearSerialAutoPlay();
    const max = serialOrderedScenes().length - 1;
    if (serialState.index < max) { serialState.index += 1; renderSerialPlayer(); }
  });
  $("#serialRestartBtn").addEventListener("click", () => {
    clearSerialAutoPlay(); serialState.index = 0; renderSerialPlayer();
  });
  $("#serialAutoPlayBtn").addEventListener("click", toggleSerialAutoPlay);
  $("#fullscreenSerialBtn").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === elements.serialPlayer) await document.exitFullscreen();
      else await elements.serialPlayer.requestFullscreen();
    } catch (error) { showToast(`无法切换全屏：${error.message}`, true); }
  });
  $("#closeSerialBtn").addEventListener("click", closeSerialPreview);
  $(".serial-backdrop").addEventListener("click", closeSerialPreview);
  $("#closeMediaPreviewBtn").addEventListener("click", closeMediaPreview);
  $(".media-preview-backdrop").addEventListener("click", closeMediaPreview);

  // Esc 关闭弹窗
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.mediaPreviewModal.hidden) closeMediaPreview();
    else if (!elements.treeModal.hidden) closeTreeBrowser();
    else if (!elements.storyModal.hidden) closeStoryPreview();
    else if (!elements.serialModal.hidden) closeSerialPreview();
  });

  // 参考镜头
  elements.sceneReference.addEventListener("change", () => { syncEditorToScene(); renderReferenceSelector(selectedScene()); });

  // 提示词合成
  $("#composeImagePrompt").addEventListener("click", () => { const scene = selectedScene(); if (scene) { syncEditorToScene(); scene.imagePrompt = composeImagePrompt(scene); saveProject(); renderEditor(); } });
  $("#composeVideoPrompt").addEventListener("click", () => { const scene = selectedScene(); if (scene) { syncEditorToScene(); scene.videoPrompt = composeVideoPrompt(scene); saveProject(); renderEditor(); } });

  // 生成
  $("#generateImageBtn").addEventListener("click", generateImage);
  $("#generateVideoBtn").addEventListener("click", generateVideo);
  $("#resetImageBtn").addEventListener("click", () => resetAsset("image"));
  $("#resetVideoBtn").addEventListener("click", () => resetAsset("video"));

  // 项目管理
  $("#exportBtn").addEventListener("click", exportProject);
  $("#saveProjectBtn").addEventListener("click", persistProject);
  $("#importBtn").addEventListener("click", () => $("#importInput").click());
  $("#importInput").addEventListener("change", (event) => { if (event.target.files[0]) importProject(event.target.files[0]); event.target.value = ""; });
  $("#openProjectFolderBtn").addEventListener("click", () => openAssetFolder());
  $("#openSceneFolderBtn").addEventListener("click", () => { const scene = selectedScene(); if (scene) openAssetFolder(scene.id); });

  // 表单同步
  [elements.projectTitle, elements.projectSynopsis, elements.projectGenre, elements.projectAspect,
    elements.projectStyle, elements.projectCharacter,
    elements.projectTextBaseUrl, elements.projectTextModel,
    elements.projectImageBaseUrl, elements.projectImageModel, elements.projectImageEditModel,
    elements.projectVideoBaseUrl, elements.projectVideoModel,
  ].forEach((element) => element.addEventListener("change", saveProject));
  [elements.projectTextApiKey, elements.projectImageApiKey, elements.projectVideoApiKey]
    .forEach((element) => element.addEventListener("change", saveProviderSecrets));
  [elements.projectTreeDepth, elements.projectBranchCount].forEach((element) => element.addEventListener("change", () => { updateTreeEstimate(); saveProject(); }));
  ["projectEpisodeCount", "projectShotsPerEpisode", "projectSerialTone"].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("change", () => { updateSerialEstimate(); saveProject(); });
  });
  [elements.episodeTitle, elements.episodeSynopsis, elements.episodeObjective, elements.episodeHook, elements.episodeEnding, elements.episodeShotCount]
    .forEach((element) => element?.addEventListener("change", () => { syncEpisodeFromForm(); saveProject(); renderEpisodeList(); updateSerialEstimate(); }));
  [elements.sceneTitle, elements.sceneShot, elements.sceneDuration, elements.sceneAction, elements.sceneDialogue, elements.sceneImagePrompt, elements.sceneVideoPrompt].forEach((element) => element.addEventListener("change", syncEditorToScene));
  [elements.sceneTransition, elements.sceneEntryState, elements.sceneExitState].forEach((element) => element?.addEventListener("change", syncEditorToScene));
  [elements.sceneDuration, elements.sceneDialogue].forEach((element) => element.addEventListener("input", () => updateDialogueTiming()));
  ["sceneEpisode", "sceneEpisodeOrder"].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("change", syncEditorToScene);
  });
}

async function checkHealth() {
  const status = $("#apiStatus");
  try {
    const health = await requestJson("/api/health");
    status.textContent = health.keyConfigured
      ? `本地服务 ${health.version || "未知版本"} · 默认密钥已配置`
      : `本地服务 ${health.version || "未知版本"} · 请配置供应商密钥`;
    status.className = `status-pill ${health.keyConfigured ? "ready" : "warning"}`;
  } catch { status.textContent = "本地服务异常"; status.className = "status-pill warning"; }
}

window.FrameForgeApp = {
  getProject: () => project,
  syncProject() { syncEditorToScene(); saveProject(); },
  validateStory: validateStoryGraph,
  requestJson,
  showToast,
};

window.FrameForgeFeatures.register({
  id: "workbench-core",
  order: 10,
  init() {
    applyMetaToForm();
    bindEvents();
    render();
    document.body.dataset.appReady = "true";
    checkHealth();
  },
});
