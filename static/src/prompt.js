import { currentMode } from "./state.js";
import { narrativeSentences, transitionLabel } from "./utils.js";
import { readMetaFromForm, orderedScenes, saveProject, characterCardToText } from "./project-model.js";
import { renderEditor } from "./render.js";
import { showToast } from "./utils.js";

// ─────────────────────────────────────────────
//  短剧镜头衔接推断
// ─────────────────────────────────────────────
export function serialSceneNeighbors(scene) {
  const scenes = orderedScenes();
  const index = scenes.findIndex((candidate) => candidate.id === scene.id);
  return {
    previous: index > 0 ? scenes[index - 1] : null,
    next: index >= 0 && index + 1 < scenes.length ? scenes[index + 1] : null,
  };
}

export function inferEntryState(scene, previous) {
  if (scene.entryState) return scene.entryState;
  if (previous?.exitState) return previous.exitState;
  return previous ? `承接上一镜“${previous.title}”结束时的人物位置、视线、道具和情绪。` : "从稳定定场状态开始。";
}

export function inferExitState(scene, next) {
  if (scene.exitState) return scene.exitState;
  const action = narrativeSentences(scene.action).slice(-1)[0] || scene.action || "人物动作短暂停留";
  return `${String(action).slice(0, 120)}；结尾保持可衔接的姿势与视线${next ? `，为“${next.title}”留出动作方向` : ""}。`;
}

export function rebuildSerialTransitions(showResult = false, preserveCamera = false, force = false) {
  if (currentMode !== "serial") return;
  const scenes = orderedScenes();
  if (force) scenes.forEach((scene) => { scene.entryState = ""; scene.exitState = ""; });
  scenes.forEach((scene, index) => {
    const previous = scenes[index - 1] || null;
    const next = scenes[index + 1] || null;
    scene.transition = index === 0 ? "cut" : (scene.transition || "match");
    scene.entryState = inferEntryState(scene, previous);
    scene.exitState = inferExitState(scene, next);
    if (previous && !previous.exitState) previous.exitState = scene.entryState;
  });
  scenes.forEach((scene) => {
    scene.videoPrompt = preserveCamera
      ? mergeVideoNarrativeContext(scene.videoPrompt, scene)
      : composeVideoPrompt(scene);
  });
  if (showResult) { saveProject(); renderEditor(); showToast(`已重建 ${scenes.length} 个镜头的衔接状态。`); }
}

// ─────────────────────────────────────────────
//  提示词合成
// ─────────────────────────────────────────────
// 按出场角色注入角色连续性区块：优先用 scene.characterIds 指定的角色，
// 未指定时默认用主角（第一张角色卡），回退到旧 meta.character 文本。
// 对应文章方法论："每个相关镜头都重复角色核心识别信息"。
function characterContinuityBlock(scene) {
  const meta = readMetaFromForm();
  const cards = Array.isArray(meta.characters) ? meta.characters : [];
  let active = [];
  if (Array.isArray(scene.characterIds) && scene.characterIds.length) {
    active = scene.characterIds.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
  }
  if (!active.length) active = cards.slice(0, 1);
  if (!active.length && meta.character) return `角色连续性设定：${meta.character}。`;
  if (!active.length) return "";
  const list = active.map(characterCardToText).join("；");
  return `角色连续性设定：${list}。同一镜头内严格保持角色外观、发型、服装与道具一致。`;
}

export function composeCharacterPortraitPrompt(card) {
  const meta = readMetaFromForm();
  const parts = [
    "角色设定参考图，全身正面像，中性背景。",
    `角色：${card.name}。`,
    card.ageRange ? `年龄：${card.ageRange}。` : "",
    card.gender ? `性别呈现：${card.gender}。` : "",
    card.hair ? `发型：${card.hair}。` : "",
    card.outfit ? `服装：${card.outfit}。` : "",
    card.props ? `携带物品/特征：${card.props}。` : "",
    card.emotion ? `情绪基调：${card.emotion}。` : "",
    card.performance ? `表演风格：${card.performance}。` : "",
    card.notes ? `补充：${card.notes}。` : "",
    meta.visualStyle ? `视觉风格：${meta.visualStyle}。` : "",
    "清晰展示角色面部、发型、服装和道具细节，供后续镜头角色一致性参考。无文字、无水印、无界面元素。",
  ];
  return parts.filter(Boolean).join("\n");
}

export function composeSceneCardPrompt(card) {
  const meta = readMetaFromForm();
  const parts = [
    "场景设定参考图，无人物的空镜 establishing shot。",
    `场景：${card.name}。`,
    card.type ? `场景类型：${card.type}。` : "",
    card.lighting ? `光照：${card.lighting}。` : "",
    card.colorTone ? `色调：${card.colorTone}。` : "",
    card.atmosphere ? `氛围：${card.atmosphere}。` : "",
    card.environment ? `环境细节：${card.environment}。` : "",
    card.timeOfDay ? `时间/天气：${card.timeOfDay}。` : "",
    card.notes ? `补充：${card.notes}。` : "",
    meta.visualStyle ? `视觉风格：${meta.visualStyle}。` : "",
    "清晰展示场景空间布局、光照条件和环境道具，供后续镜头场景一致性参考。无文字、无水印、无界面元素。",
  ];
  return parts.filter(Boolean).join("\n");
}

function sceneCardBlock(scene) {
  const meta = readMetaFromForm();
  const cards = Array.isArray(meta.sceneCards) ? meta.sceneCards : [];
  const card = scene.sceneCardId ? cards.find((c) => c.id === scene.sceneCardId) : null;
  if (!card) return "";
  const parts = [
    card.lighting ? `光照：${card.lighting}` : "",
    card.colorTone ? `色调：${card.colorTone}` : "",
    card.atmosphere ? `氛围：${card.atmosphere}` : "",
    card.environment ? `环境：${card.environment}` : "",
  ].filter(Boolean).join("，");
  return `场景连续性设定：${card.name}。${parts}。同一镜头内严格保持场景光照、色调和环境一致。`;
}

export function composeImagePrompt(scene) {
  const meta = readMetaFromForm();
  const modeLabel = currentMode === "serial" ? "AI短剧" : `${meta.genre}互动影游`;
  const entryState = currentMode === "serial" ? inferEntryState(scene, serialSceneNeighbors(scene).previous) : "";
  return [
    `${modeLabel}的电影关键帧，${scene.shot}。`,
    entryState ? `这是当前视频的起始帧，人物、视线、位置、道具和环境必须准确处于入口状态：${entryState}` : "",
    `当前镜头唯一事件与表演：${scene.action || "角色处于故事场景中"}。`,
    characterContinuityBlock(scene),
    sceneCardBlock(scene),
    meta.visualStyle ? `视觉风格：${meta.visualStyle}。` : "",
    `只表现当前镜头，不概括、不预演本集其他情节。构图适合${meta.aspectRatio}画幅，电影灯光，无文字、无水印、无界面元素。`,
  ].filter(Boolean).join("\n");
}

export function composeVideoPrompt(scene) {
  const cameraPrompt = [
    `${scene.shot}电影镜头。`,
    "保持首帧人物身份、脸部、服装和场景结构一致。",
    "自然呼吸与细微环境动态，运动连贯，镜头稳定，避免形体变形、闪烁、跳切和新增角色。",
  ].filter(Boolean).join(" ");
  return mergeVideoNarrativeContext(cameraPrompt, scene);
}

export function videoNarrativeContext(scene) {
  const { previous, next } = currentMode === "serial" ? serialSceneNeighbors(scene) : { previous: null, next: null };
  const action = scene.action || "角色保持自然细微动作，延续上一镜头的情绪与空间关系。";
  const dialogue = scene.dialogue || "无对白或旁白，以动作、表情和环境声推进叙事。";
  const entryState = inferEntryState(scene, previous);
  const exitState = inferExitState(scene, next);
  return [
    "【当前镜头】",
    currentMode === "serial" ? `衔接方式：${transitionLabel(scene.transition)}。` : "",
    currentMode === "serial" ? `开头入口状态：${entryState}` : "",
    `本镜头唯一事件与表演：${action}`,
    `本镜头对白 / 旁白：${dialogue}`,
    currentMode === "serial" ? `结尾出口状态：${exitState}` : "",
    `时长：${scene.duration || 8} 秒。对白必须在该时长内以自然、清晰、可听懂的语速完成，并保留必要停顿。`,
    currentMode === "serial" ? "开头约 0.3 秒准确保持入口状态，再自然开始动作；结尾约 0.3 秒收束到出口状态并稳定停留，期间避免新增动作或台词，为下一镜转场预留余量。" : "",
    "只执行上述一个镜头事件，不总结、不预演、不补演本集其他情节，不朗读剧情描述。动作、表情、视线和口型仅服务于当前对白；保持人物运动方向、屏幕方位和环境光线连续。画面不显示字幕或文字。",
    "【/当前镜头】",
  ].filter(Boolean).join("\n");
}

export function mergeVideoNarrativeContext(prompt, scene) {
  const cameraPrompt = String(prompt || "")
    .replace(/\n?【剧情连续性】[\s\S]*?【\/剧情连续性】/g, "")
    .replace(/\n?【当前镜头】[\s\S]*?【\/当前镜头】/g, "")
    .split("\n")
    .filter((line) => !/^\s*(本集设定|本集叙事|全剧梗概|本集梗概|叙事目标|结尾目标)[：:]/.test(line))
    .join("\n")
    .trim();
  return [cameraPrompt, videoNarrativeContext(scene)].filter(Boolean).join("\n\n");
}
