import {
  $, elements, currentMode, project,
  playerState, setPlayerState, serialState, setSerialState,
} from "./state.js";
import { escapeHtml, showToast } from "./utils.js";
import { readMetaFromForm } from "./project-model.js";
import { syncEditorToScene } from "./render.js";
import { syncEpisodeFromForm } from "./episodes.js";
import { proxyMediaUrl } from "./api.js";

// ─────────────────────────────────────────────
//  互动影游试玩器
// ─────────────────────────────────────────────
export function startStoryPreview(startSceneId = project.startSceneId) {
  syncEditorToScene();
  if (!project.scenes.length) return showToast("请先创建剧情节点。", true);
  const start = project.scenes.find((scene) => scene.id === startSceneId);
  if (!start) return showToast("试玩起点不存在。", true);
  clearStoryAutoTimer();
  setPlayerState({ sceneId: start.id, history: [], startSceneId: start.id, autoTimer: null });
  const meta = readMetaFromForm();
  $("#playerProjectTitle").textContent = meta.title;
  applyStoryPlayerAspect(meta.aspectRatio);
  elements.storyModal.hidden = false;
  document.body.classList.add("modal-open");
  renderStoryPlayer();
}

export function applyStoryPlayerAspect(aspectRatio) {
  const aspect = ["16:9", "9:16", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9";
  elements.storyPlayer.dataset.aspect = aspect;
  elements.storyPlayer.style.setProperty("--player-aspect", aspect.replace(":", " / "));
  elements.playerStage.setAttribute("aria-label", `${aspect} 画幅预览`);
}

export function closeStoryPreview() {
  clearStoryAutoTimer();
  const video = elements.playerStage.querySelector("video");
  if (video) video.pause();
  if (document.fullscreenElement === elements.storyPlayer) document.exitFullscreen().catch(() => {});
  elements.storyModal.hidden = true;
  document.body.classList.remove("modal-open");
}

export async function toggleStoryFullscreen() {
  try {
    if (document.fullscreenElement === elements.storyPlayer) await document.exitFullscreen();
    else await elements.storyPlayer.requestFullscreen();
  } catch (error) { showToast(`无法切换全屏：${error.message}`, true); }
}

export function updateFullscreenButton() {
  const btn = $("#fullscreenStoryBtn");
  if (btn) btn.textContent = document.fullscreenElement === elements.storyPlayer ? "退出全屏" : "进入全屏";
  const sBtn = $("#fullscreenSerialBtn");
  if (sBtn) sBtn.textContent = document.fullscreenElement === elements.serialPlayer ? "退出全屏" : "全屏";
}

export function goToPlayerScene(targetSceneId, choiceText = "") {
  clearStoryAutoTimer();
  const target = project.scenes.find((scene) => scene.id === targetSceneId);
  if (!target) return showToast("这个选择尚未连接到有效剧情节点。", true);
  playerState.history.push({ sceneId: playerState.sceneId, choiceText });
  playerState.sceneId = target.id;
  renderStoryPlayer();
}

export function clearStoryAutoTimer() {
  if (playerState.autoTimer) { clearTimeout(playerState.autoTimer); playerState.autoTimer = null; }
}

export function shouldAutoContinueStory(scene) {
  return Boolean(scene?.nextSceneId && !scene.choices.length && scene.shotsInNode > 1);
}

export function autoContinueStory(scene) {
  if (!shouldAutoContinueStory(scene)) return;
  goToPlayerScene(scene.nextSceneId);
}

export function renderStoryPlayer() {
  const scene = project.scenes.find((item) => item.id === playerState.sceneId);
  if (!scene) return closeStoryPreview();
  clearStoryAutoTimer();
  applyStoryPlayerAspect(readMetaFromForm().aspectRatio);
  const index = project.scenes.findIndex((item) => item.id === scene.id);
  $("#playerProgress").textContent = scene.shotsInNode > 1
    ? `分镜 ${scene.shotInNode}/${scene.shotsInNode} · 已做出 ${playerState.history.filter((item) => item.choiceText).length} 次选择`
    : `节点 ${String(index + 1).padStart(2, "0")} · 已做出 ${playerState.history.filter((item) => item.choiceText).length} 次选择`;
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
    if (shouldAutoContinueStory(scene)) video.addEventListener("ended", () => autoContinueStory(scene), { once: true });
    frame.appendChild(video); elements.playerStage.appendChild(frame);
  } else if (imageUrl) {
    const frame = document.createElement("div"); frame.className = "player-media-frame";
    const image = document.createElement("img"); image.src = imageUrl; image.alt = scene.title;
    frame.appendChild(image); elements.playerStage.appendChild(frame);
    if (shouldAutoContinueStory(scene)) playerState.autoTimer = setTimeout(() => autoContinueStory(scene), (scene.duration || 8) * 1000);
  } else {
    elements.playerStage.innerHTML = `<div class="player-no-media"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(scene.title)}</strong><small>该节点尚未生成影音素材</small></div>`;
    if (shouldAutoContinueStory(scene)) playerState.autoTimer = setTimeout(() => autoContinueStory(scene), 3000);
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
//  AI 短剧线性播放器
// ─────────────────────────────────────────────
export function serialOrderedScenes() {
  return window.FrameForgeEpisodeModel.allScenes(project);
}

export function startSerialPreview(startIndex = 0) {
  syncEditorToScene();
  syncEpisodeFromForm();
  if (!serialOrderedScenes().length) return showToast("请先创建短剧镜头。", true);
  clearSerialAutoPlay();
  setSerialState({ index: startIndex, autoPlay: false, autoTimer: null });
  const meta = readMetaFromForm();
  $("#serialPlayerTitle").textContent = meta.title;
  applySerialPlayerAspect(meta.aspectRatio);
  elements.serialModal.hidden = false;
  document.body.classList.add("modal-open");
  renderSerialPlayer();
}

export function applySerialPlayerAspect(aspectRatio) {
  const aspect = ["16:9", "9:16", "1:1"].includes(aspectRatio) ? aspectRatio : "16:9";
  elements.serialPlayer.dataset.aspect = aspect;
  elements.serialPlayer.style.setProperty("--player-aspect", aspect.replace(":", " / "));
}

export function closeSerialPreview() {
  clearSerialAutoPlay();
  const video = elements.serialStage.querySelector("video");
  if (video) video.pause();
  if (document.fullscreenElement === elements.serialPlayer) document.exitFullscreen().catch(() => {});
  elements.serialModal.hidden = true;
  document.body.classList.remove("modal-open");
}

export function clearSerialAutoPlay() {
  if (serialState.autoTimer) { clearTimeout(serialState.autoTimer); serialState.autoTimer = null; }
  serialState.autoPlay = false;
  const btn = $("#serialAutoPlayBtn");
  if (btn) btn.textContent = "▶ 自动播放";
}

export function renderSerialPlayer() {
  const scenes = serialOrderedScenes();
  if (!scenes.length) return closeSerialPreview();
  const index = Math.max(0, Math.min(serialState.index, scenes.length - 1));
  serialState.index = index;
  const scene = scenes[index];

  const ep = scene.episode || 1;
  const epOrder = scene.episodeOrder || (index + 1);
  const totalEps = new Set(scenes.map((s) => s.episode || 1)).size;
  $("#serialEpTag").textContent = `第${ep}集 · 第${epOrder}镜`;
  $("#serialProgress").textContent = `${index + 1} / ${scenes.length}`;
  $("#serialSceneTitle").textContent = scene.title;
  $("#serialAction").textContent = scene.action || "";
  $("#serialDialogue").textContent = scene.dialogue || "";
  $("#serialDialogue").hidden = !scene.dialogue;

  $("#serialPrevBtn").disabled = index <= 0;
  $("#serialNextBtn").disabled = index >= scenes.length - 1;

  elements.serialStage.innerHTML = "";
  const videoUrl = scene.videoLocalUrl || (scene.videoUrl ? proxyMediaUrl(scene.videoUrl) : "");
  const imageUrl = scene.imageLocalUrl || (scene.imageUrl ? proxyMediaUrl(scene.imageUrl) : "");
  if (videoUrl) {
    const frame = document.createElement("div"); frame.className = "player-media-frame";
    const video = document.createElement("video");
    video.src = videoUrl; video.controls = true; video.autoplay = serialState.autoPlay; video.playsInline = true;
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

export function toggleSerialAutoPlay() {
  if (serialState.autoPlay) { clearSerialAutoPlay(); }
  else {
    serialState.autoPlay = true;
    $("#serialAutoPlayBtn").textContent = "⏸ 暂停";
    renderSerialPlayer();
  }
}

// ─────────────────────────────────────────────
//  媒体预览弹窗
// ─────────────────────────────────────────────
export function openMediaPreview(kind, url, title) {
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

export function closeMediaPreview() {
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
