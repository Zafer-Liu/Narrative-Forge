import { currentMode, project } from "./state.js";
import { showToast } from "./utils.js";
import { orderedScenes } from "./project-model.js";
import { syncEpisodeFromForm } from "./episodes.js";
import { syncEditorToScene } from "./render.js";

// ─────────────────────────────────────────────
//  分支检查（互动影游 & 短剧）
// ─────────────────────────────────────────────
export function validateStoryGraph(showResult = true) {
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

export function storyTargets(scene) {
  if (scene.choices.length) return scene.choices.map((choice) => ({ id: choice.targetSceneId, label: choice.text }));
  return scene.nextSceneId ? [{ id: scene.nextSceneId, label: "继续" }] : [];
}

export function storyNodeTitle(scene) {
  return String(scene?.title || "未命名剧情节点").replace(/\s*·\s*分镜\s*\d+\s*\/\s*\d+\s*$/, "");
}

export function interactiveStoryGroups() {
  const groups = [];
  const groupByKey = new Map();
  orderedScenes().forEach((scene) => {
    const key = scene.storyNodeKey || scene.id;
    if (!groupByKey.has(key)) {
      const group = { key, scenes: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    groupByKey.get(key).scenes.push(scene);
  });
  return groups;
}
