import { $, elements, currentMode, project, draggedEpisodeId, setDraggedEpisodeId } from "./state.js";
import { escapeHtml, showToast } from "./utils.js";
import {
  activeEpisode, ensureAtLeastOneEpisode, saveProject,
} from "./project-model.js";
import { render, syncEditorToScene } from "./render.js";

export function syncEpisodeFromForm() {
  const episode = activeEpisode();
  if (!episode || !elements.episodeTitle) return;
  episode.meta.title = elements.episodeTitle.value.trim() || `第${episode.order + 1}集`;
  episode.meta.synopsis = elements.episodeSynopsis.value.trim();
  episode.meta.objective = elements.episodeObjective.value.trim();
  episode.meta.hook = elements.episodeHook.value.trim();
  episode.meta.ending = elements.episodeEnding.value.trim();
  episode.meta.shotCount = Math.max(1, Number(elements.episodeShotCount.value) || project.meta.shotsPerEpisode || 5);
}

export function applyEpisodeToForm() {
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

export function selectEpisode(episodeId) {
  if (episodeId === project.selectedEpisodeId) return;
  syncEditorToScene();
  syncEpisodeFromForm();
  project.selectedEpisodeId = episodeId;
  const episode = activeEpisode();
  if (episode) episode.selectedSceneId = episode.selectedSceneId || episode.startSceneId || episode.scenes[0]?.id || null;
  saveProject();
  render();
}

export function renderEpisodeList() {
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
    card.addEventListener("dragstart", () => { setDraggedEpisodeId(episode.id); card.classList.add("dragging"); });
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
    card.addEventListener("dragend", () => { setDraggedEpisodeId(null); card.classList.remove("dragging", "drag-over"); });
    elements.episodeList.appendChild(card);
  });
  applyEpisodeToForm();
}

export function addEpisode() {
  syncEditorToScene(); syncEpisodeFromForm();
  const episode = window.FrameForgeEpisodeModel.create(project.episodes.length, { shotCount: project.meta.shotsPerEpisode || 5 });
  project.episodes.push(episode);
  project.selectedEpisodeId = episode.id;
  project.meta.episodeCount = project.episodes.length;
  $("#projectEpisodeCount").value = String(project.episodes.length);
  saveProject(); render();
}

export function deleteEpisode() {
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

export function syncEpisodesToPlan() {
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
