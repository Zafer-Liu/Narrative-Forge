// AI 短剧分集数据模型（ESM 版）。
// 仍挂载到 window.FrameForgeEpisodeModel，保持与现有 project-model 调用方式兼容。
"use strict";

function uid() {
  return `episode_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function create(index, defaults = {}, partial = {}) {
  const order = number(partial.order, index);
  const episodeNumber = order + 1;
  const meta = partial.meta && typeof partial.meta === "object" ? partial.meta : {};
  return {
    id: partial.id || uid(),
    order,
    meta: {
      title: meta.title || `第${episodeNumber}集`,
      synopsis: meta.synopsis || "",
      objective: meta.objective || "",
      hook: meta.hook || "",
      ending: meta.ending || "",
      shotCount: number(meta.shotCount, number(defaults.shotCount, 5)),
    },
    scenes: Array.isArray(partial.scenes) ? partial.scenes : [],
    startSceneId: partial.startSceneId || null,
    selectedSceneId: partial.selectedSceneId || null,
  };
}

export function normalizeEpisodes(project) {
  const defaults = { shotCount: number(project.meta?.shotsPerEpisode, 5) };
  project.episodes = (Array.isArray(project.episodes) ? project.episodes : [])
    .filter((episode) => episode && typeof episode === "object")
    .map((episode, index) => create(index, defaults, episode))
    .sort((left, right) => left.order - right.order);
  project.episodes.forEach((episode, index) => {
    episode.order = index;
    episode.meta.shotCount = Math.max(1, Math.min(30, number(episode.meta.shotCount, defaults.shotCount)));
    episode.scenes.forEach((scene, sceneIndex) => {
      scene.episode = index + 1;
      scene.episodeOrder = number(scene.episodeOrder, sceneIndex + 1);
    });
    episode.startSceneId = episode.startSceneId || episode.scenes[0]?.id || null;
    episode.selectedSceneId = episode.scenes.some((scene) => scene.id === episode.selectedSceneId)
      ? episode.selectedSceneId
      : episode.startSceneId;
  });
  if (!project.episodes.some((episode) => episode.id === project.selectedEpisodeId)) {
    project.selectedEpisodeId = project.episodes[0]?.id || null;
  }
}

export function migrate(project) {
  const legacyScenes = Array.isArray(project.scenes) ? project.scenes : [];
  const legacyStart = project.startSceneId || null;
  const legacySelected = project.selectedSceneId || null;
  const serialLegacy = project.meta?.mode === "serial" || legacyScenes.some((scene) => number(scene?.episode, 1) > 1);

  if (!project.interactive || typeof project.interactive !== "object") {
    project.interactive = {
      scenes: serialLegacy ? [] : legacyScenes,
      startSceneId: serialLegacy ? null : legacyStart,
      selectedSceneId: serialLegacy ? null : legacySelected,
    };
  }
  project.interactive.scenes = Array.isArray(project.interactive.scenes) ? project.interactive.scenes : [];
  project.interactive.startSceneId = project.interactive.startSceneId || project.interactive.scenes[0]?.id || null;
  project.interactive.selectedSceneId = project.interactive.selectedSceneId || project.interactive.startSceneId;

  if (!Array.isArray(project.episodes) && serialLegacy && legacyScenes.length) {
    const grouped = new Map();
    legacyScenes.forEach((scene) => {
      const episodeNumber = Math.max(1, number(scene.episode, 1));
      if (!grouped.has(episodeNumber)) grouped.set(episodeNumber, []);
      grouped.get(episodeNumber).push(scene);
    });
    project.episodes = [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([episodeNumber, scenes], index) => {
      scenes.sort((left, right) => number(left.episodeOrder, left.order) - number(right.episodeOrder, right.order));
      const sceneIds = new Set(scenes.map((scene) => scene.id));
      return create(index, { shotCount: project.meta?.shotsPerEpisode }, {
        meta: { title: `第${episodeNumber}集`, shotCount: scenes.length || project.meta?.shotsPerEpisode },
        scenes,
        startSceneId: sceneIds.has(legacyStart) ? legacyStart : scenes[0]?.id,
        selectedSceneId: sceneIds.has(legacySelected) ? legacySelected : scenes[0]?.id,
      });
    });
  }

  normalizeEpisodes(project);
  delete project.scenes;
  delete project.startSceneId;
  delete project.selectedSceneId;
  installFacade(project);
  return project;
}

export function active(project) {
  if (!project.episodes.length) return null;
  return project.episodes.find((episode) => episode.id === project.selectedEpisodeId) || project.episodes[0];
}

function activeContainer(project) {
  if (project.meta?.mode === "serial") return active(project) || project.interactive;
  return project.interactive;
}

function installFacade(project) {
  Object.defineProperties(project, {
    scenes: {
      configurable: true,
      get() { return activeContainer(project).scenes; },
      set(value) { activeContainer(project).scenes = Array.isArray(value) ? value : []; },
    },
    startSceneId: {
      configurable: true,
      get() { return activeContainer(project).startSceneId; },
      set(value) { activeContainer(project).startSceneId = value || null; },
    },
    selectedSceneId: {
      configurable: true,
      get() { return activeContainer(project).selectedSceneId; },
      set(value) { activeContainer(project).selectedSceneId = value || null; },
    },
  });
}

export function allScenes(project) {
  return [...project.episodes]
    .sort((left, right) => left.order - right.order)
    .flatMap((episode, episodeIndex) => [...episode.scenes]
      .sort((left, right) => number(left.episodeOrder, left.order) - number(right.episodeOrder, right.order))
      .map((scene, sceneIndex) => ({ ...scene, episode: episodeIndex + 1, episodeOrder: sceneIndex + 1 })));
}

export const EpisodeModel = { active, allScenes, create, migrate, normalizeEpisodes };

// 兼容旧代码：仍暴露全局
if (typeof window !== "undefined") {
  window.FrameForgeEpisodeModel = EpisodeModel;
}
