import { $, project, activeTasks } from "./state.js";
import { showToast, spokenCharacterCount, dialogueBudget, recommendedDialogueDuration, imageSizeForAspect } from "./utils.js";
import {
  readMetaFromForm, saveProject, selectedScene, findSceneAcrossProject,
  saveProviderSecrets, providerSettings, orderedScenes,
} from "./project-model.js";
import { syncEditorToScene, renderEditor, renderMedia, render, renderCharacterPanel, renderSceneCardPanel } from "./render.js";
import { renderSceneList } from "./scene-list.js";
import { composeCharacterPortraitPrompt, composeSceneCardPrompt } from "./prompt.js";

// ─────────────────────────────────────────────
//  HTTP
// ─────────────────────────────────────────────
export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detailObj = data.details || {};
    const detailValue = typeof data.details === "string"
      ? data.details
      : detailObj.message || detailObj.detail || detailObj.error?.message
        || (detailObj.error_kind ? `[${detailObj.error_kind}] ${detailObj.error_detail || ""}` : "")
        || "";
    const details = detailValue ? ` ${detailValue}` : "";
    const error = new Error((data.error || `请求失败 (${response.status})`) + details);
    error.status = response.status;
    error.retryable = detailObj.retryable;
    error.reason = detailObj.reason || "";
    error.errorKind = detailObj.error_kind || "";
    throw error;
  }
  return data;
}

// ─────────────────────────────────────────────
//  任务控制
// ─────────────────────────────────────────────
export function taskKey(sceneId, kind) { return `${sceneId}:${kind}`; }

export function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("任务已停止", "AbortError"));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("任务已停止", "AbortError")); }, { once: true });
  });
}

export function createTask(scene, kind) {
  const key = taskKey(scene.id, kind);
  activeTasks.get(key)?.controller.abort();
  const task = { controller: new AbortController(), token: `${Date.now()}-${Math.random()}` };
  activeTasks.set(key, task);
  return task;
}

export function isTaskActive(scene, kind, task) {
  return !task.controller.signal.aborted && activeTasks.get(taskKey(scene.id, kind))?.token === task.token;
}

export function stopTask(sceneId, kind) {
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

export async function resetAsset(kind) {
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
    scene[`${item}Url`] = ""; scene[`${item}LocalUrl`] = ""; scene[`${item}Path`] = "";
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

export function renderTaskResult(scene) {
  renderSceneList();
  if (project.selectedSceneId === scene.id) renderEditor();
}

// ─────────────────────────────────────────────
//  预测轮询
// ─────────────────────────────────────────────
export function predictionId(result) {
  const id = result?.data?.id;
  if (!id) throw new Error("模型供应商未返回任务 ID。");
  return id;
}

export async function pollPrediction(id, onProgress, signal, kind) {
  const deadline = Date.now() + 20 * 60 * 1000;
  let consecutiveErrors = 0;
  saveProviderSecrets();
  const provider = providerSettings(kind);
  while (Date.now() < deadline) {
    let result;
    try {
      result = await requestJson(`/api/predictions/${encodeURIComponent(id)}`, {
        signal,
        headers: {
          "X-Provider-Base-Url": provider.baseUrl,
          "X-Provider-Api-Key": provider.apiKey,
          "X-Provider-Kind": kind,
          "X-Provider-Name": provider.provider || "atlascloud",
        },
      });
      consecutiveErrors = 0;
    } catch (error) {
      if (error.name === "AbortError" || signal?.aborted) throw error;
      if (error.retryable === false || [400, 401, 402, 403, 404].includes(error.status)) throw error;
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

// ─────────────────────────────────────────────
//  素材保存
// ─────────────────────────────────────────────
export async function saveAsset(scene, kind, button = null, quiet = false) {
  const remoteUrl = kind === "image" ? scene.imageUrl : scene.videoUrl;
  if (!remoteUrl) return null;
  if (button) { button.disabled = true; button.textContent = "保存中…"; }
  try {
    const result = await requestJson("/api/save-asset", { method: "POST", body: JSON.stringify({
      url: remoteUrl, kind, project_title: readMetaFromForm().title, scene_id: scene.id,
    }) });
    scene[`${kind}LocalUrl`] = result.localUrl;
    scene[`${kind}Path`] = result.path || "";
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
//  关键帧 / 视频生成
// ─────────────────────────────────────────────
export async function generateImage() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene?.imagePrompt) return showToast("请先填写关键帧提示词。", true);
  // 多参考图：角色参考（场景间参考 > 角色卡设定图）+ 场景卡参考图
  const sceneRef = findSceneAcrossProject(scene.referenceSceneId);
  if (scene.referenceSceneId && !sceneRef?.imageUrl && !sceneRef?.imageLocalUrl) return showToast("所选角色参考镜头尚未生成关键帧。", true);
  const _charPrefix = "将参考图仅用于保持角色身份一致：严格保留同一张脸、年龄、发型、肤色、体型和服装设计。不要照搬参考图的背景、姿势、动作或构图，必须完全依据当前镜头重新构图：\n";
  const _scenePrefix = "将参考图仅用于保持场景环境一致：严格保留光照、色调、空间布局和环境道具。不要照搬参考图中的人物或具体构图，必须完全依据当前镜头重新构图：\n";
  const _meta = readMetaFromForm();
  const referenceImageUrls = [];
  const prefixParts = [];
  // ① 角色参考图：场景间参考 > 角色卡设定图
  if (sceneRef?.imageUrl || sceneRef?.imageLocalUrl) {
    referenceImageUrls.push(sceneRef.imageUrl || sceneRef.imageLocalUrl);
    prefixParts.push(_charPrefix);
  } else {
    const _characters = Array.isArray(_meta.characters) ? _meta.characters : [];
    const _charIds = Array.isArray(scene.characterIds) ? scene.characterIds : [];
    const _activeChars = _charIds.length ? _charIds.map((id) => _characters.find((c) => c.id === id)).filter(Boolean) : _characters.slice(0, 1);
    const _charWithImage = _activeChars.find((c) => c.imageUrl);
    if (_charWithImage) {
      referenceImageUrls.push(_charWithImage.imageUrl);
      prefixParts.push(_charPrefix);
    }
  }
  // ② 场景卡参考图：用于环境一致性
  const _sceneCards = Array.isArray(_meta.sceneCards) ? _meta.sceneCards : [];
  const _sceneCard = scene.sceneCardId ? _sceneCards.find((c) => c.id === scene.sceneCardId) : null;
  if (_sceneCard?.imageUrl) {
    referenceImageUrls.push(_sceneCard.imageUrl);
    prefixParts.push(_scenePrefix);
  }
  const referencePrefix = prefixParts.join("");
  const task = createTask(scene, "image");
  saveProviderSecrets();
  const provider = providerSettings("image");
  scene.imageStatus = "working"; scene.imagePredictionId = ""; saveProject(); render();
  try {
    const started = await requestJson("/api/generate-image", { method: "POST", body: JSON.stringify({
      prompt: referenceImageUrls.length ? `${referencePrefix}${scene.imagePrompt}` : scene.imagePrompt,
      reference_image_url: referenceImageUrls[0] || "",
      reference_image_urls: referenceImageUrls,
      quality: $("#imageQuality").value, output_format: $("#imageFormat").value,
      size: imageSizeForAspect(project.meta.aspectRatio), moderation: "low",
      image_base_url: provider.baseUrl, image_api_key: provider.apiKey,
      image_model: provider.model, image_edit_model: providerSettings("imageEdit").model || provider.model,
      image_provider: provider.provider,
    }), signal: task.controller.signal });
    if (!isTaskActive(scene, "image", task)) throw new DOMException("任务已清除", "AbortError");
    scene.imagePredictionId = predictionId(started); saveProject();
    if (project.selectedSceneId === scene.id) renderMedia(scene);
    scene.imageUrl = await pollPrediction(scene.imagePredictionId, null, task.controller.signal, "image");
    if (!isTaskActive(scene, "image", task)) throw new DOMException("任务已清除", "AbortError");
    scene.imageStatus = "completed"; scene.imagePredictionId = "";
    scene.imageLocalUrl = ""; scene.imagePath = ""; scene.videoUrl = ""; scene.videoLocalUrl = ""; scene.videoPath = ""; scene.videoStatus = "idle";
    await saveAsset(scene, "image", null, true);
    showToast(scene.imageLocalUrl ? "关键帧生成完成并已保存到项目。" : "关键帧生成完成，可使用保存按钮落盘。");
  } catch (error) {
    if (error.name !== "AbortError") { scene.imageStatus = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(taskKey(scene.id, "image"))?.token === task.token) activeTasks.delete(taskKey(scene.id, "image"));
    saveProject(); renderTaskResult(scene);
  }
}

// ─────────────────────────────────────────────
//  角色卡设定图生成
// ─────────────────────────────────────────────
export async function generateCharacterImage(cardId) {
  let card = project.meta.characters?.find((c) => c.id === cardId);
  if (!card) return showToast("找不到该角色卡。", true);
  const prompt = composeCharacterPortraitPrompt(card);
  if (!prompt) return showToast("角色卡信息不足，无法生成图片。", true);

  const key = `char:${cardId}:image`;
  activeTasks.get(key)?.controller.abort();
  const controller = new AbortController();
  const token = `${Date.now()}-${Math.random()}`;
  activeTasks.set(key, { controller, token });

  saveProviderSecrets();
  const provider = providerSettings("image");
  card.imageStatus = "working"; card.imagePredictionId = "";
  saveProject(); renderCharacterPanel();
  card = project.meta.characters?.find((c) => c.id === cardId);
  try {
    const started = await requestJson("/api/generate-image", { method: "POST", body: JSON.stringify({
      prompt,
      reference_image_url: "",
      quality: "high", output_format: "png",
      size: "1024x1024", moderation: "low",
      image_base_url: provider.baseUrl, image_api_key: provider.apiKey,
      image_model: provider.model,
      image_edit_model: providerSettings("imageEdit").model || provider.model,
      image_provider: provider.provider,
    }), signal: controller.signal });
    const predId = predictionId(started);
    card.imagePredictionId = predId; saveProject(); renderCharacterPanel();
    card = project.meta.characters?.find((c) => c.id === cardId);
    const imageUrl = await pollPrediction(predId, null, controller.signal, "image");
    card.imageUrl = imageUrl; card.imageStatus = "completed"; card.imagePredictionId = "";
    saveProject(); renderCharacterPanel();
    showToast(`角色「${card.name}」设定图生成完成。`);
  } catch (error) {
    card = project.meta.characters?.find((c) => c.id === cardId);
    if (card && error.name !== "AbortError") { card.imageStatus = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(key)?.token === token) activeTasks.delete(key);
    saveProject(); renderCharacterPanel();
  }
}

export function stopCharacterImageTask(cardId) {
  const key = `char:${cardId}:image`;
  activeTasks.get(key)?.controller.abort();
  activeTasks.delete(key);
  const card = project.meta.characters?.find((c) => c.id === cardId);
  if (card) {
    card.imageStatus = card.imagePredictionId ? "paused" : "idle";
    saveProject(); renderCharacterPanel();
    showToast("已停止角色图生成。供应商后台任务可能仍在运行。");
  }
}

// ─────────────────────────────────────────────
//  场景卡参考图生成
// ─────────────────────────────────────────────
export async function generateSceneCardImage(cardId) {
  let card = project.meta.sceneCards?.find((c) => c.id === cardId);
  if (!card) return showToast("找不到该场景卡。", true);
  const prompt = composeSceneCardPrompt(card);
  if (!prompt) return showToast("场景卡信息不足，无法生成图片。", true);

  const key = `scene:${cardId}:image`;
  activeTasks.get(key)?.controller.abort();
  const controller = new AbortController();
  const token = `${Date.now()}-${Math.random()}`;
  activeTasks.set(key, { controller, token });

  saveProviderSecrets();
  const provider = providerSettings("image");
  card.imageStatus = "working"; card.imagePredictionId = "";
  saveProject(); renderSceneCardPanel();
  card = project.meta.sceneCards?.find((c) => c.id === cardId);
  try {
    const started = await requestJson("/api/generate-image", { method: "POST", body: JSON.stringify({
      prompt,
      reference_image_url: "",
      quality: "high", output_format: "png",
      size: "1024x1024", moderation: "low",
      image_base_url: provider.baseUrl, image_api_key: provider.apiKey,
      image_model: provider.model,
      image_edit_model: providerSettings("imageEdit").model || provider.model,
      image_provider: provider.provider,
    }), signal: controller.signal });
    const predId = predictionId(started);
    card.imagePredictionId = predId; saveProject(); renderSceneCardPanel();
    card = project.meta.sceneCards?.find((c) => c.id === cardId);
    const imageUrl = await pollPrediction(predId, null, controller.signal, "image");
    card.imageUrl = imageUrl; card.imageStatus = "completed"; card.imagePredictionId = "";
    saveProject(); renderSceneCardPanel();
    showToast(`场景「${card.name}」参考图生成完成。`);
  } catch (error) {
    card = project.meta.sceneCards?.find((c) => c.id === cardId);
    if (card && error.name !== "AbortError") { card.imageStatus = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(key)?.token === token) activeTasks.delete(key);
    saveProject(); renderSceneCardPanel();
  }
}

export function stopSceneCardImageTask(cardId) {
  const key = `scene:${cardId}:image`;
  activeTasks.get(key)?.controller.abort();
  activeTasks.delete(key);
  const card = project.meta.sceneCards?.find((c) => c.id === cardId);
  if (card) {
    card.imageStatus = card.imagePredictionId ? "paused" : "idle";
    saveProject(); renderSceneCardPanel();
    showToast("已停止场景图生成。供应商后台任务可能仍在运行。");
  }
}

export async function generateVideo() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene?.imageUrl && !scene?.imageLocalUrl) return showToast("请先为当前镜头生成关键帧。", true);
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
      prompt: scene.videoPrompt, image_url: scene.imageUrl || scene.imageLocalUrl, duration: scene.duration,
      resolution: $("#videoResolution").value, aspect_ratio: project.meta.aspectRatio,
      video_base_url: provider.baseUrl, video_api_key: provider.apiKey, video_model: provider.model,
      video_provider: provider.provider,
    }), signal: task.controller.signal });
    if (!isTaskActive(scene, "video", task)) throw new DOMException("任务已清除", "AbortError");
    scene.videoPredictionId = predictionId(started); saveProject();
    if (project.selectedSceneId === scene.id) renderMedia(scene);
    scene.videoUrl = await pollPrediction(scene.videoPredictionId, null, task.controller.signal, "video");
    if (!isTaskActive(scene, "video", task)) throw new DOMException("任务已清除", "AbortError");
    scene.videoStatus = "completed"; scene.videoPredictionId = ""; scene.videoLocalUrl = ""; scene.videoPath = "";
    await saveAsset(scene, "video", null, true);
    showToast(scene.videoLocalUrl ? "视频生成完成并已保存到项目。" : "视频生成完成，可使用保存按钮落盘。");
  } catch (error) {
    if (error.name !== "AbortError") { scene.videoStatus = "failed"; showToast(error.message, true); }
  } finally {
    if (activeTasks.get(taskKey(scene.id, "video"))?.token === task.token) activeTasks.delete(taskKey(scene.id, "video"));
    saveProject(); renderTaskResult(scene);
  }
}

export async function resumeTask(scene, kind) {
  const predictionIdValue = scene[`${kind}PredictionId`];
  if (!predictionIdValue) return showToast("没有可继续查询的任务 ID。", true);
  const task = createTask(scene, kind);
  scene[`${kind}Status`] = "working"; saveProject(); render();
  try {
    const output = await pollPrediction(predictionIdValue, null, task.controller.signal, kind);
    scene[`${kind}Url`] = output; scene[`${kind}LocalUrl`] = ""; scene[`${kind}Path`] = "";
    scene[`${kind}Status`] = "completed"; scene[`${kind}PredictionId`] = "";
    if (kind === "image") { scene.videoUrl = ""; scene.videoLocalUrl = ""; scene.videoPath = ""; scene.videoStatus = "idle"; }
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
//  批量关键帧生成
// ─────────────────────────────────────────────
let _batchAbort = false;

export async function batchGenerateImages() {
  const scenes = orderedScenes();
  const pending = scenes.filter((s) => s.imageStatus !== "working" && (!s.imageUrl || s.imageStatus === "failed"));
  if (!pending.length) return showToast("没有需要生成关键帧的镜头。");
  if (!confirm(`将为 ${pending.length} 个镜头批量生成关键帧，确认开始？`)) return;
  _batchAbort = false;
  const batchBtn = $("#batchImageBtn");
  const originalHTML = batchBtn?.innerHTML || "";
  if (batchBtn) { batchBtn.classList.add("generating"); }
  let completed = 0, failed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (_batchAbort) break;
    const scene = pending[i];
    project.selectedSceneId = scene.id; saveProject(); render();
    if (batchBtn) batchBtn.textContent = `批量 ${i + 1}/${pending.length}（点击停止）`;
    await generateImage();
    if (scene.imageStatus === "completed") completed++; else failed++;
  }
  if (batchBtn) { batchBtn.classList.remove("generating"); batchBtn.innerHTML = originalHTML; }
  _batchAbort = false;
  if (completed + failed > 0) showToast(`批量完成：${completed} 成功${failed ? `，${failed} 失败` : ""}。`, failed > 0);
}

export function stopBatchImageGeneration() {
  _batchAbort = true;
  const scenes = orderedScenes();
  for (const scene of scenes) {
    if (scene.imageStatus === "working") { stopTask(scene.id, "image"); break; }
  }
}

// ─────────────────────────────────────────────
//  项目导入/导出/文件夹
// ─────────────────────────────────────────────
export function proxyMediaUrl(url) {
  if (!url || url.startsWith("/projects/") || url.startsWith("/samples/")) return url;
  return `/api/media?url=${encodeURIComponent(url)}`;
}
export function downloadMediaUrl(url, filename) {
  if (url?.startsWith("/projects/") || url?.startsWith("/samples/")) return url;
  return `/api/media?download=1&filename=${encodeURIComponent(filename)}&url=${encodeURIComponent(url)}`;
}
