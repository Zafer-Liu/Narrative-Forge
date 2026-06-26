import { $, elements, currentMode, project, treeZoom } from "./state.js";
import { showToast } from "./utils.js";
import {
  selectedScene, createScene, normalizeSceneOrder, activeEpisode, serialSceneEntries, saveProject,
  saveProviderSecrets,
} from "./project-model.js";
import { setMode } from "./mode.js";
import { composeImagePrompt, composeVideoPrompt, rebuildSerialTransitions } from "./prompt.js";
import { render, renderEditor, syncEditorToScene, addChoice, updateDialogueTiming, renderReferenceSelector } from "./render.js";
import { renderSceneList } from "./scene-list.js";
import { generateStoryDraft, buildLocalDraft, testTextProvider, testImageProvider, testVideoProvider, updateTreeEstimate, updateSerialEstimate } from "./draft.js";
import {
  selectEpisode, addEpisode, deleteEpisode, syncEpisodesToPlan, syncEpisodeFromForm, renderEpisodeList,
} from "./episodes.js";
import { openTreeBrowser, closeTreeBrowser, setTreeZoom, toggleTreeFullscreen, closeTreeDetail, resetTreeLayout, toggleTreeShots, treeDetailPrev, treeDetailNext, treeDetailTogglePlayAll } from "./tree.js";
import { validateStoryGraph } from "./story-graph.js";
import {
  startStoryPreview, closeStoryPreview, toggleStoryFullscreen, updateFullscreenButton,
  startSerialPreview, closeSerialPreview, clearSerialAutoPlay, renderSerialPlayer,
  toggleSerialAutoPlay, serialOrderedScenes, closeMediaPreview, renderStoryPlayer,
} from "./player.js";
import { setPlayerState, playerState, serialState } from "./state.js";
import { generateImage, generateVideo, resetAsset, requestJson } from "./api.js";
import { exportProject, loadBundledExample, persistProject, importProject, openAssetFolder } from "./project-io.js";
import { restoreProjectSnapshot } from "./project-model.js";

export function bindEvents() {
  // 模式切换
  document.querySelectorAll(".mode-tab").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  // 草案生成
  $("#draftBtn").addEventListener("click", generateStoryDraft);
  $("#localDraftBtn").addEventListener("click", buildLocalDraft);
  $("#testTextProviderBtn").addEventListener("click", testTextProvider);
  $("#testImageProviderBtn")?.addEventListener("click", testImageProvider);
  $("#testVideoProviderBtn")?.addEventListener("click", testVideoProvider);

  // 剧情树
  $("#browseTreeBtn").addEventListener("click", openTreeBrowser);
  $("#closeTreeBtn").addEventListener("click", closeTreeBrowser);
  $(".tree-backdrop").addEventListener("click", closeTreeBrowser);
  $("#treeZoomOutBtn").addEventListener("click", () => setTreeZoom(treeZoom - .15));
  $("#treeZoomInBtn").addEventListener("click", () => setTreeZoom(treeZoom + .15));
  $("#treeZoomResetBtn").addEventListener("click", () => setTreeZoom(1));
  $("#treeFullscreenBtn").addEventListener("click", toggleTreeFullscreen);
  $("#treeResetLayoutBtn")?.addEventListener("click", resetTreeLayout);
  $("#treeToggleShotsBtn")?.addEventListener("click", toggleTreeShots);
  $("#treeDetailCloseBtn")?.addEventListener("click", closeTreeDetail);
  $("#treeDetailPrevBtn")?.addEventListener("click", treeDetailPrev);
  $("#treeDetailNextBtn")?.addEventListener("click", treeDetailNext);
  $("#treeDetailPlayAllBtn")?.addEventListener("click", treeDetailTogglePlayAll);

  // 分镜列表
  $("#addSceneBtn").addEventListener("click", () => {
    syncEditorToScene();
    const previous = selectedScene();
    const scene = createScene();
    scene.imagePrompt = composeImagePrompt(scene); scene.videoPrompt = composeVideoPrompt(scene);
    if (previous && currentMode === "interactive" && !previous.nextSceneId && !previous.choices.length) previous.nextSceneId = scene.id;
    project.scenes.push(scene); project.selectedSceneId = scene.id; saveProject(); render();
  });
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
    setPlayerState({ sceneId: playerState.startSceneId, history: [], startSceneId: playerState.startSceneId, autoTimer: null });
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
    else if (!$("#treeDetail")?.hidden) closeTreeDetail();
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
  $("#loadExampleBtn").addEventListener("click", loadBundledExample);
  $("#saveProjectBtn").addEventListener("click", persistProject);
  $("#restoreProjectBtn").addEventListener("click", restoreProjectSnapshot);
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
  bindProviderSwitch(elements.projectImageProvider, "image");
  bindProviderSwitch(elements.projectVideoProvider, "video");
  [elements.projectTextApiKey, elements.projectImageApiKey, elements.projectVideoApiKey]
    .forEach((element) => element.addEventListener("change", saveProviderSecrets));
  [elements.projectTreeDepth, elements.projectBranchCount, elements.projectInteractiveShotsPerNode]
    .forEach((element) => element?.addEventListener("change", () => { updateTreeEstimate(); saveProject(); }));
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

// 切换图像/视频供应商时，自动把 Base URL 与模型 ID 填为该供应商的推荐默认值，
// 避免用户拿着 AtlasCloud 的地址去打通义万相而困惑。默认值来自后端 /api/providers。
let _providerDefaults = null;
async function loadProviderDefaults() {
  if (_providerDefaults) return _providerDefaults;
  try {
    const data = await requestJson("/api/providers");
    _providerDefaults = data.providers || {};
  } catch { _providerDefaults = {}; }
  return _providerDefaults;
}

function bindProviderSwitch(select, kind) {
  if (!select) return;
  select.addEventListener("change", async () => {
    const defaults = await loadProviderDefaults();
    const entry = (defaults[kind] || []).find((item) => item.name === select.value);
    if (entry) {
      const baseInput = $(`#project${kind === "image" ? "Image" : "Video"}BaseUrl`);
      const modelInput = $(`#project${kind === "image" ? "Image" : "Video"}Model`);
      if (baseInput) baseInput.value = entry.defaultBaseUrl;
      if (modelInput) modelInput.value = entry.defaultModel;
      if (kind === "image" && entry.defaultEditModel && elements.projectImageEditModel) {
        elements.projectImageEditModel.value = entry.defaultEditModel;
      }
    }
    saveProject();
  });
}
