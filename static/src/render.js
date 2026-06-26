import { $, elements, currentMode, project } from "./state.js";
import { escapeHtml, showToast, spokenCharacterCount, dialogueBudget, choiceUid } from "./utils.js";
import {
  selectedScene, orderedScenes, activeEpisode, serialSceneEntries,
  findSceneAcrossProject, saveProject,
} from "./project-model.js";
import {
  inferEntryState, inferExitState, serialSceneNeighbors,
  composeImagePrompt, composeVideoPrompt, mergeVideoNarrativeContext,
} from "./prompt.js";
import { renderSceneList } from "./scene-list.js";
import { renderEpisodeList } from "./episodes.js";
import { updateSerialEstimate } from "./draft.js";
import {
  proxyMediaUrl, downloadMediaUrl, saveAsset, stopTask, resumeTask, requestJson,
} from "./api.js";
import { openMediaPreview } from "./player.js";

// ─────────────────────────────────────────────
//  编辑器渲染
// ─────────────────────────────────────────────
export function renderEditor() {
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

export function renderSerialFlowEditor(scene) {
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

export function updateGenerationControls(scene) {
  const imageButton = $("#generateImageBtn");
  const videoButton = $("#generateVideoBtn");
  imageButton.disabled = scene.imageStatus === "working";
  imageButton.textContent = scene.imageStatus === "working" ? "生成中…" : (scene.referenceSceneId ? "参考图生成关键帧" : "生成关键帧");
  videoButton.disabled = scene.videoStatus === "working";
  videoButton.textContent = scene.videoStatus === "working" ? "生成中…" : "由关键帧生成视频";
  $("#resetImageBtn").disabled = false;
  $("#resetVideoBtn").disabled = false;
}

export function renderReferenceSelector(scene) {
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

export function sceneOptions(selectedId, excludeId = "") {
  const options = ['<option value="">— 无 / 剧情结束 —</option>'];
  orderedScenes().forEach((scene, index) => {
    if (scene.id === excludeId) return;
    const selected = scene.id === selectedId ? " selected" : "";
    options.push(`<option value="${escapeHtml(scene.id)}"${selected}>${String(index + 1).padStart(2, "0")} · ${escapeHtml(scene.title)}</option>`);
  });
  return options.join("");
}

export function renderFlowEditor(scene) {
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

export function addChoice() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene) return;
  scene.choices.push({ id: choiceUid(), text: `选择 ${scene.choices.length + 1}`, effect: "", targetSceneId: "" });
  saveProject(); renderFlowEditor(scene); renderSceneList();
}

export function updateDialogueTiming(scene = selectedScene()) {
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

// ─────────────────────────────────────────────
//  媒体渲染（编辑器）
// ─────────────────────────────────────────────
export function renderMedia(scene) {
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
  renderMediaPathEditor(scene, "image", elements.imageCard);
  renderMediaPathEditor(scene, "video", elements.videoCard);
}

export function renderMediaPathEditor(scene, kind, card) {
  const label = kind === "image" ? "图片路径" : "视频路径";
  const editor = document.createElement("div");
  editor.className = "media-path-editor";
  editor.innerHTML = `<label><span>${label}</span><input type="text" spellcheck="false" placeholder="projects 内的本地路径，或 https:// 素材地址"></label><button class="button ghost media-path-apply">应用</button>`;
  const input = editor.querySelector("input");
  input.value = scene[`${kind}Path`] || scene[`${kind}LocalUrl`] || scene[`${kind}Url`] || "";
  const apply = async () => {
    const value = input.value.trim();
    const button = editor.querySelector("button");
    if (!value) {
      scene[`${kind}Url`] = ""; scene[`${kind}LocalUrl`] = ""; scene[`${kind}Path`] = ""; scene[`${kind}Status`] = "idle";
      saveProject(); renderMedia(scene); return;
    }
    if (/^https:\/\//i.test(value)) {
      scene[`${kind}Url`] = value; scene[`${kind}LocalUrl`] = ""; scene[`${kind}Path`] = ""; scene[`${kind}Status`] = "completed";
      saveProject(); renderMedia(scene); showToast(`${label}已更新。`); return;
    }
    button.disabled = true; button.textContent = "检查中…";
    try {
      const result = await requestJson("/api/resolve-asset-path", { method: "POST", body: JSON.stringify({ path: value, kind }) });
      scene[`${kind}LocalUrl`] = result.localUrl; scene[`${kind}Path`] = result.path; scene[`${kind}Status`] = "completed";
      saveProject(); renderMedia(scene); showToast(`${label}已恢复：${result.path}`);
    } catch (error) { showToast(error.message, true); button.disabled = false; button.textContent = "应用"; }
  };
  editor.querySelector("button").addEventListener("click", apply);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } });
  card.appendChild(editor);
}

export function renderTaskResult(scene) {
  renderSceneList();
  if (project.selectedSceneId === scene.id) renderEditor();
}

// ─────────────────────────────────────────────
//  编辑器同步
// ─────────────────────────────────────────────
export function syncEditorToScene() {
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

export function render() {
  if (currentMode === "serial") renderEpisodeList();
  renderSceneList();
  renderEditor();
  if (currentMode === "serial") updateSerialEstimate();
}
