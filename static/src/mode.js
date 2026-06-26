import { $, currentMode, setCurrentMode, project } from "./state.js";
import { saveProject, ensureAtLeastOneEpisode } from "./project-model.js";
import { rebuildSerialTransitions } from "./prompt.js";
import { syncEditorToScene, render } from "./render.js";
import { syncEpisodeFromForm } from "./episodes.js";
import { updateTreeEstimate, updateSerialEstimate } from "./draft.js";

export function setMode(mode) {
  const appReady = document.body.dataset.appReady === "true";
  if (appReady && currentMode === "serial") syncEpisodeFromForm();
  if (appReady) syncEditorToScene();
  setCurrentMode(mode);
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
