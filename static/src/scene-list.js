import {
  $, elements, currentMode, project,
  draggedSceneId, setDraggedSceneId, draggedSceneSource, setDraggedSceneSource,
} from "./state.js";
import { escapeHtml, statusClass, showToast } from "./utils.js";
import { orderedScenes, activeEpisode, moveSceneRelative, saveProject } from "./project-model.js";
import { interactiveStoryGroups, storyNodeTitle } from "./story-graph.js";
import { syncEditorToScene, render, renderEditor } from "./render.js";
import { renderTreeBrowser } from "./tree.js";

function sceneCardBadges(scene) {
  const parts = [];
  if (Array.isArray(scene.characterIds) && scene.characterIds.length)
    parts.push(`<span class="badge">角色${scene.characterIds.length}</span>`);
  if (scene.sceneCardId)
    parts.push(`<span class="badge scene">场景</span>`);
  return parts.length ? `<span class="scene-card-badges">${parts.join("")}</span>` : "";
}

export function renderSceneList() {
  if (currentMode === "serial") {
    const filter = $("#serialEpisodeFilter");
    if (filter) {
      filter.innerHTML = project.episodes.map((episode, index) => `<option value="${episode.id}"${episode.id === project.selectedEpisodeId ? " selected" : ""}>第${index + 1}集 · ${escapeHtml(episode.meta.title)}</option>`).join("");
    }
  }

  elements.sceneList.innerHTML = "";
  const scenes = orderedScenes();
  const groups = currentMode === "interactive" ? interactiveStoryGroups() : [];
  if (currentMode === "interactive" && groups.some((group) => group.scenes.length > 1)) {
    groups.forEach((group, groupIndex) => {
      const container = document.createElement("section");
      container.className = `scene-group${group.scenes.some((scene) => scene.id === project.selectedSceneId) ? " active" : ""}`;
      const tail = group.scenes[group.scenes.length - 1];
      const flowLabel = tail.choices.length ? `${tail.choices.length} 个选择` : tail.nextSceneId ? "自动进入下一剧情" : "结局";
      container.innerHTML = `<header class="scene-group-header">
        <span class="scene-group-index">${String(groupIndex + 1).padStart(2, "0")}</span>
        <div><strong>${escapeHtml(storyNodeTitle(group.scenes[0]))}</strong><small>${group.scenes.length} 个分镜 · ${flowLabel}</small></div>
      </header><div class="scene-group-shots"></div>`;
      const list = container.querySelector(".scene-group-shots");
      group.scenes.forEach((scene, shotIndex) => {
        const item = document.createElement("div");
        item.className = `scene-item scene-item-nested${scene.id === project.selectedSceneId ? " active" : ""}`;
        item.draggable = true;
        item.dataset.sceneId = scene.id;
        const flow = scene.choices.length ? `${scene.choices.length} 个选择` : scene.nextSceneId ? "自动连接" : "结局";
        item.innerHTML = `<span class="scene-index">${String(shotIndex + 1).padStart(2, "0")}</span>
          <strong></strong><span class="scene-meta">${escapeHtml(scene.shot)} · ${scene.duration} 秒 · ${flow}</span>${sceneCardBadges(scene)}
          ${scene.id === project.startSceneId ? '<span class="start-badge">起点</span>' : ""}
          <span class="asset-dots"><i class="${statusClass(scene.imageStatus, scene.imageUrl || scene.imageLocalUrl)}"></i><i class="${statusClass(scene.videoStatus, scene.videoUrl || scene.videoLocalUrl)}"></i></span>`;
        item.querySelector("strong").textContent = scene.title.replace(/\s*·\s*分镜\s*\d+\s*\/\s*\d+\s*$/, "");
        item.addEventListener("click", () => { syncEditorToScene(); project.selectedSceneId = scene.id; saveProject(); render(); });
        bindSceneDrag(item, scene.id, "list");
        list.appendChild(item);
      });
      elements.sceneList.appendChild(container);
    });
    return;
  }

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
      const shotLabel = scene.shotsInNode > 1 ? `分镜 ${scene.shotInNode}/${scene.shotsInNode} · ` : "";
      metaText = `${shotLabel}${escapeHtml(scene.shot)} · ${scene.duration} 秒 · ${flowLabel}`;
    }
    item.innerHTML = `<span class="scene-index">${String(index + 1).padStart(2, "0")}</span>
      <strong></strong><span class="scene-meta">${metaText}</span>${sceneCardBadges(scene)}
      ${scene.id === project.startSceneId ? '<span class="start-badge">起点</span>' : ""}
      <span class="asset-dots"><i class="${statusClass(scene.imageStatus, scene.imageUrl || scene.imageLocalUrl)}"></i><i class="${statusClass(scene.videoStatus, scene.videoUrl || scene.videoLocalUrl)}"></i></span>`;
    item.querySelector("strong").textContent = scene.title;
    item.addEventListener("click", () => { syncEditorToScene(); project.selectedSceneId = scene.id; saveProject(); render(); });
    bindSceneDrag(item, scene.id, "list");
    elements.sceneList.appendChild(item);
  });
}

export function clearDragStyles() {
  document.querySelectorAll(".dragging, .drag-over, .drag-invalid").forEach((element) => {
    element.classList.remove("dragging", "drag-over", "drag-invalid");
  });
}

export function bindSceneDrag(element, sceneId, source, depthById = null) {
  element.addEventListener("dragstart", (event) => {
    setDraggedSceneId(sceneId); setDraggedSceneSource(source);
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
    setDraggedSceneId(null); setDraggedSceneSource(""); clearDragStyles();
  });
  element.addEventListener("dragend", () => { setDraggedSceneId(null); setDraggedSceneSource(""); clearDragStyles(); });
}
