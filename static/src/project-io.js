import { project, setProject } from "./state.js";
import { $ } from "./state.js";
import { showToast } from "./utils.js";
import {
  normalizeProject, readMetaFromForm, applyMetaToForm, saveProject,
  snapshotProjectBeforeReplacement, updateRecoveryButton,
} from "./project-model.js";
import { syncEditorToScene, render } from "./render.js";
import { syncEpisodeFromForm } from "./episodes.js";
import { requestJson } from "./api.js";

export function exportProject() {
  syncEditorToScene(); syncEpisodeFromForm(); saveProject();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${project.meta.title || "narrative-forge-project"}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function persistProject() {
  syncEditorToScene(); syncEpisodeFromForm(); saveProject();
  const button = $("#saveProjectBtn");
  button.disabled = true; button.textContent = "保存中…";
  try {
    const result = await requestJson("/api/save-project", { method: "POST", body: JSON.stringify({ project }) });
    showToast(result.backupPath ? `项目已保存到 ${result.path}；旧版本已备份。` : `项目已保存到 ${result.path}`);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; button.textContent = "保存项目"; }
}

export async function importProject(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const hasScenes = Array.isArray(parsed?.scenes) || Array.isArray(parsed?.interactive?.scenes) || Array.isArray(parsed?.episodes);
    if (!parsed?.meta || !hasScenes) throw new Error("不是有效的 Narrative Forge 项目文件。");
    if (project.scenes.length && !confirm("导入会替换当前工作区项目。系统会保留一份可撤销快照，确定继续吗？")) return;
    if (project.scenes.length) snapshotProjectBeforeReplacement(`导入“${parsed.meta.title || file.name}”前`);
    setProject(normalizeProject(parsed));
    project.selectedSceneId = project.selectedSceneId || project.scenes[0]?.id || null;
    applyMetaToForm(); saveProject(); render(); showToast("项目已导入。");
  } catch (error) { showToast(error.message, true); }
}

export async function loadBundledExample() {
  try {
    if (project.scenes.length && !confirm("加载内置案例会替换当前工作区项目。系统会保留一份可撤销快照，确定继续吗？")) return;
    const example = await requestJson("/samples/star-sea-echo.project.json");
    if (project.scenes.length) snapshotProjectBeforeReplacement("加载内置案例前");
    setProject(normalizeProject(example));
    applyMetaToForm(); saveProject(); render(); updateRecoveryButton();
    showToast("已加载内置案例：星海回声。");
  } catch (error) { showToast(`加载案例失败：${error.message}`, true); }
}

export async function openAssetFolder(sceneId = "") {
  try {
    const result = await requestJson("/api/open-folder", { method: "POST", body: JSON.stringify({ project_title: readMetaFromForm().title, scene_id: sceneId }) });
    showToast(`已打开 ${result.path}`);
  } catch (error) { showToast(error.message, true); }
}

export async function checkHealth() {
  const status = $("#apiStatus");
  try {
    const health = await requestJson("/api/health");
    status.textContent = health.keyConfigured
      ? `本地服务 ${health.version || "未知版本"} · 默认密钥已配置`
      : `本地服务 ${health.version || "未知版本"} · 请配置供应商密钥`;
    status.className = `status-pill ${health.keyConfigured ? "ready" : "warning"}`;
  } catch { status.textContent = "本地服务异常"; status.className = "status-pill warning"; }
}
