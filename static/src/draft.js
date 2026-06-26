import {
  $, elements, currentMode, project,
  textGenController, setTextGenController, textGenTimer, setTextGenTimer, TEXT_GEN_TIMEOUT_MS,
} from "./state.js";
import {
  showToast, choiceUid, uid, narrativeSentences, atomicNarrativeBeat,
  spokenCharacterCount, dialogueBudget, recommendedDialogueDuration,
  estimatedTreeNodes, parseStoryJson, formatTextGenError,
} from "./utils.js";
import {
  readMetaFromForm, saveProject, createScene, normalizeSceneOrder,
  activeEpisode, ensureAtLeastOneEpisode, firstEpisodeMasterScene,
  snapshotProjectBeforeReplacement, saveProviderSecrets, providerSettings,
} from "./project-model.js";
import { composeImagePrompt, composeVideoPrompt, rebuildSerialTransitions } from "./prompt.js";
import { syncEpisodeFromForm } from "./episodes.js";
import { render } from "./render.js";
import { requestJson } from "./api.js";

// ─────────────────────────────────────────────
//  草案请求元信息与确认
// ─────────────────────────────────────────────
export function draftRequestMeta() {
  const meta = readMetaFromForm();
  const episode = currentMode === "serial" ? ensureAtLeastOneEpisode() : null;
  if (!meta.synopsis.trim() && !episode?.meta.synopsis.trim()) { showToast("请先填写项目故事梗概或本集剧情梗概。", true); return null; }
  if (currentMode === "interactive") {
    const storyNodeCount = estimatedTreeNodes(meta.treeDepth, meta.branchCount);
    const shotsPerNode = meta.interactiveShotsPerNode || 1;
    const nodeCount = storyNodeCount * shotsPerNode;
    if (storyNodeCount > 160 || nodeCount > 240) {
      showToast(`该组合会生成 ${storyNodeCount} 个剧情节点 / ${nodeCount} 个分镜，超过安全上限。请降低深度、分支数或每节点分镜数。`, true);
      return null;
    }
    return { meta, nodeCount, storyNodeCount, shotsPerNode };
  }
  // 短剧模式
  syncEpisodeFromForm();
  const nodeCount = episode.meta.shotCount || meta.shotsPerEpisode;
  if (nodeCount > 200) {
    showToast(`当前集会生成 ${nodeCount} 个镜头，超过 200 个上限。请降低目标镜头数。`, true);
    return null;
  }
  return { meta, nodeCount, episode };
}

export function confirmDraftReplacement() {
  if (!project.scenes.length) return true;
  const scope = currentMode === "serial" ? `当前集“${activeEpisode()?.meta.title || "未命名"}”的全部镜头` : "当前全部剧情节点";
  const accepted = confirm(`生成草案会替换${scope}，但不会删除已保存到磁盘的素材。继续吗？`);
  if (accepted) snapshotProjectBeforeReplacement(`生成草案前：${scope}`);
  return accepted;
}

export function splitNarrativeBeats(action, count, fallback) {
  const sentences = narrativeSentences(action);
  if (!sentences.length) sentences.push(fallback || action || "角色完成当前剧情段的关键行动。");
  return Array.from({ length: count }, (_, index) => {
    const text = sentences[index] || sentences[Math.min(index, sentences.length - 1)] || fallback || "";
    const prefixes = count <= 1 ? [""] : ["建立当前情境：", "推进核心动作：", "承接变化反应：", "揭示即时结果：", "收束到选择前状态："];
    return `${prefixes[Math.min(index, prefixes.length - 1)]}${text}`.slice(0, 6000);
  });
}

export function expandInteractiveStoryScenes(baseScenes, idByKey, shotsPerNode) {
  if (shotsPerNode <= 1) return { scenes: baseScenes, startIdByKey: idByKey };
  const expanded = [];
  const startIdByKey = new Map();
  const startIdByBaseId = new Map();
  const tailByKey = new Map();
  const keyByBaseId = new Map([...idByKey.entries()].map(([key, id]) => [id, key]));
  baseScenes.forEach((baseScene, index) => {
    const key = keyByBaseId.get(baseScene.id) || `n${index}`;
    const beats = splitNarrativeBeats(baseScene.action, shotsPerNode, baseScene.title);
    let previous = null;
    for (let shotIndex = 0; shotIndex < shotsPerNode; shotIndex += 1) {
      const scene = createScene({
        ...baseScene,
        id: shotIndex === 0 ? baseScene.id : uid(),
        order: expanded.length,
        title: shotsPerNode > 1 ? `${baseScene.title} · 分镜 ${shotIndex + 1}/${shotsPerNode}` : baseScene.title,
        action: beats[shotIndex],
        dialogue: shotIndex === shotsPerNode - 1 ? baseScene.dialogue : "",
        choices: [],
        nextSceneId: "",
        storyNodeKey: key,
        shotInNode: shotIndex + 1,
        shotsInNode: shotsPerNode,
      });
      if (previous) previous.nextSceneId = scene.id;
      else {
        startIdByKey.set(key, scene.id);
        startIdByBaseId.set(baseScene.id, scene.id);
      }
      expanded.push(scene);
      previous = scene;
    }
    tailByKey.set(key, previous);
  });
  baseScenes.forEach((baseScene, index) => {
    const key = keyByBaseId.get(baseScene.id) || `n${index}`;
    const tail = tailByKey.get(key);
    if (!tail) return;
    tail.choices = baseScene.choices.map((choice) => ({ ...choice, targetSceneId: startIdByBaseId.get(choice.targetSceneId) || choice.targetSceneId }));
    tail.nextSceneId = startIdByBaseId.get(baseScene.nextSceneId) || baseScene.nextSceneId || "";
  });
  return { scenes: expanded, startIdByKey };
}

// ─────────────────────────────────────────────
//  规模估算
// ─────────────────────────────────────────────
export function updateTreeEstimate() {
  const depth = Number(elements.projectTreeDepth.value || 3);
  const branches = Number(elements.projectBranchCount.value || 2);
  const shotsPerNode = Math.max(1, Math.min(5, Number(elements.projectInteractiveShotsPerNode?.value || 1)));
  const storyNodes = estimatedTreeNodes(depth, branches);
  const nodes = storyNodes * shotsPerNode;
  const endings = branches ** (depth - 1);
  const estimate = $("#treeEstimate");
  estimate.textContent = shotsPerNode > 1
    ? `预计 ${storyNodes} 个剧情节点 · ${nodes} 个分镜 · ${endings} 个结局`
    : `预计 ${storyNodes} 个节点 · ${endings} 个结局`;
  estimate.className = `tree-estimate${storyNodes > 160 || nodes > 240 ? " warning" : ""}`;
  $("#draftBtn").disabled = storyNodes > 160 || nodes > 240;
}

export function updateSerialEstimate() {
  const episodes = Number($("#projectEpisodeCount")?.value || 5);
  const shots = Number($("#projectShotsPerEpisode")?.value || 12);
  const configuredTotal = project?.episodes?.reduce((sum, episode) => sum + (Number(episode.meta?.shotCount) || shots), 0) || 0;
  const total = configuredTotal || episodes * shots;
  const currentShots = activeEpisode()?.meta.shotCount || shots;
  const estimate = $("#serialEstimate");
  if (estimate) {
    estimate.textContent = `当前集 ${currentShots} 镜 · 全剧计划 ${episodes} 集 / ${total} 镜`;
    estimate.className = `tree-estimate${total > 200 ? " warning" : ""}`;
  }
  if ($("#draftBtn")) $("#draftBtn").disabled = currentShots > 200;
}

// ─────────────────────────────────────────────
//  本地模板草案
// ─────────────────────────────────────────────
export function buildLocalDraft() {
  if (currentMode === "serial") { buildLocalSerialDraft(); return; }
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, nodeCount, storyNodeCount, shotsPerNode } = request;
  project.meta = meta;
  const baseScenes = [];
  const levels = [];
  const idByKey = new Map();
  const stageNames = ["序幕", "探索", "线索", "抉择", "终局"];
  const actions = ["谨慎调查异常源", "追踪隐藏线索", "面对意外阻碍", "验证关键证据"];
  for (let level = 0; level < meta.treeDepth; level += 1) {
    const count = meta.branchCount ** level;
    const levelScenes = [];
    for (let position = 0; position < count; position += 1) {
      const isRoot = level === 0;
      const isEnding = level === meta.treeDepth - 1;
      const routeCode = position.toString(meta.branchCount).padStart(level, "0").split("").map((digit) => String.fromCharCode(65 + Number(digit))).join("-");
      const title = isRoot ? "序幕：命运起点" : isEnding ? `结局 ${routeCode}` : `${stageNames[Math.min(level, stageNames.length - 2)]} ${routeCode}`;
      const action = isRoot
        ? `建立故事世界与核心危机。${meta.synopsis} 主角发现多个可能改变命运的行动方向。`
        : isEnding
          ? `此前路线 ${routeCode} 的选择共同塑造最终结果。主角承担选择的代价，故事抵达独立结局。`
          : `沿路线 ${routeCode} 推进剧情。主角${actions[(level + position) % actions.length]}，获得新的信息，同时失去另一种可能。`;
      const scene = createScene({ title, shot: isRoot ? "大全景" : isEnding ? "全景" : level % 2 ? "中景" : "近景", action, dialogue: isRoot ? "我的选择会改变接下来的一切。" : isEnding ? "这就是我选择的未来。" : "每条路，都在揭示不同的真相。" });
      scene.imagePrompt = composeImagePrompt(scene);
      scene.videoPrompt = composeVideoPrompt(scene);
      const key = `n_${level}_${position}`;
      scene.storyNodeKey = key;
      baseScenes.push(scene); levelScenes.push(scene); idByKey.set(key, scene.id);
    }
    levels.push(levelScenes);
  }
  for (let level = 0; level < levels.length - 1; level += 1) {
    levels[level].forEach((scene, parentIndex) => {
      scene.choices = Array.from({ length: meta.branchCount }, (_, branchIndex) => {
        const target = levels[level + 1][parentIndex * meta.branchCount + branchIndex];
        return { id: choiceUid(), text: `选择 ${String.fromCharCode(65 + branchIndex)}：${["冒险追寻真相", "谨慎保存实力", "相信眼前盟友", "独自承担风险"][branchIndex]}`, effect: `进入路线 ${target.title.replace(/^(探索|线索|抉择|结局)\s*/, "")}`, targetSceneId: target.id };
      });
    });
  }
  const expanded = expandInteractiveStoryScenes(baseScenes, idByKey, shotsPerNode);
  project.scenes = expanded.scenes;
  const intro = project.scenes.find((scene) => scene.id === expanded.startIdByKey.get("n_0_0")) || project.scenes[0];
  project.startSceneId = intro.id;
  project.scenes.forEach((scene) => { scene.referenceSceneId = scene.id === intro.id ? "" : intro.id; });
  normalizeSceneOrder();
  project.selectedSceneId = intro.id;
  saveProject(); render();
  showToast(shotsPerNode > 1 ? `本地模板已生成 ${storyNodeCount} 个剧情节点 / ${nodeCount} 个分镜。` : `本地模板已生成 ${nodeCount} 个剧情节点。`);
}

export function buildLocalSerialDraft() {
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, episode } = request;
  project.meta = meta;
  project.scenes = [];
  const toneLabels = { drama: "情感正剧", thriller: "悬疑惊悚", comedy: "轻喜剧", action: "动作冒险", romance: "爱情甜宠" };
  const toneLabel = toneLabels[meta.serialTone] || "剧情";
  const episodeNumber = episode.order + 1;
  const shotCount = episode.meta.shotCount || meta.shotsPerEpisode;
  const shotNames = ["开场钩子", "人物反应", "冲突推进", "信息揭示", "情绪特写", "高潮反转", "结尾悬念"];
  const middleBeats = [
    ...narrativeSentences(episode.meta.synopsis),
    ...narrativeSentences(episode.meta.objective),
  ];
  for (let shot = 1; shot <= shotCount; shot += 1) {
    const isFirst = shot === 1;
    const isLast = shot === shotCount;
    const shotName = shotNames[Math.min(shot - 1, shotNames.length - 1)];
    const action = isFirst
      ? atomicNarrativeBeat(episode.meta.hook || episode.meta.synopsis || meta.synopsis, `以一个明确异常事件建立${toneLabel}基调。`)
      : isLast
        ? atomicNarrativeBeat(episode.meta.ending, "主角看见新的关键证据，情绪骤变，镜头停在未解悬念上。")
        : atomicNarrativeBeat(
          middleBeats[(shot - 2) % Math.max(1, middleBeats.length)],
          `${meta.character || "主角"}${["采取一个具体行动推进目标", "遭遇一个新的阻碍", "与关键人物完成一次交锋", "发现一条改变判断的信息"][shot % 4]}。`,
        );
    const scene = createScene({
      title: `第${episodeNumber}集 · ${shotName}`,
      shot: isFirst ? "大全景" : isLast ? "特写" : ["近景", "中景", "特写", "中景"][shot % 4],
      action,
      dialogue: isFirst ? "这一切，必须从现在改变。" : isLast ? "真正的答案，才刚刚出现。" : "",
      episode: episodeNumber, episodeOrder: shot, order: shot - 1,
      transition: isFirst ? "cut" : "match",
    });
    scene.imagePrompt = composeImagePrompt(scene);
    scene.videoPrompt = composeVideoPrompt(scene);
    project.scenes.push(scene);
  }
  for (let i = 0; i < project.scenes.length - 1; i += 1) {
    project.scenes[i].nextSceneId = project.scenes[i + 1].id;
    project.scenes[i].choices = [];
  }
  project.scenes[project.scenes.length - 1].nextSceneId = "";
  rebuildSerialTransitions();
  const firstScene = project.scenes[0];
  project.startSceneId = firstScene.id;
  const seriesMaster = firstEpisodeMasterScene();
  project.scenes.forEach((scene) => {
    scene.referenceSceneId = scene.id === firstScene.id
      ? (episode.order > 0 && seriesMaster?.id !== scene.id ? seriesMaster?.id || "" : "")
      : firstScene.id;
  });
  normalizeSceneOrder();
  project.selectedSceneId = firstScene.id;
  saveProject(); render();
  showToast(`“${episode.meta.title}”已生成 ${project.scenes.length} 个镜头。`);
}

// ─────────────────────────────────────────────
//  文本生成进度管理：超时、计时、取消
// ─────────────────────────────────────────────
export function startTextGenProgress(button, originalText) {
  setTextGenController(new AbortController());
  const startTime = Date.now();
  button.disabled = false;
  button.classList.add("generating");
  button.textContent = `生成中… 0s（再次点击取消）`;
  setTextGenTimer(setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed * 1000 >= TEXT_GEN_TIMEOUT_MS) {
      cancelTextGen(button, originalText);
      showToast("文本模型生成超时（15 分钟），已自动取消。可降低剧情树规模或更换模型。", true);
      return;
    }
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    button.textContent = `生成中… ${timeStr}（再次点击取消）`;
  }, 1000));
  return textGenController.signal;
}

export function cancelTextGen(button, originalText) {
  if (textGenController) { textGenController.abort(); setTextGenController(null); }
  if (textGenTimer) { clearInterval(textGenTimer); setTextGenTimer(null); }
  if (button) { button.classList.remove("generating"); button.textContent = originalText; }
}

export function isTextGenRunning() { return textGenController !== null; }

// ─────────────────────────────────────────────
//  AI 短剧生成
// ─────────────────────────────────────────────
export async function generateSerialDraft() {
  const button = $("#draftBtn");
  const originalText = "使用文本模型生成当前集";
  if (isTextGenRunning()) { cancelTextGen(button, originalText); return; }
  await Promise.resolve();
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, episode } = request;
  saveProviderSecrets();
  const provider = providerSettings("text");
  const signal = startTextGenProgress(button, originalText);
  const toneLabels = { drama: "情感正剧", thriller: "悬疑惊悚", comedy: "轻喜剧", action: "动作冒险", romance: "爱情甜宠" };
  const episodeNumber = episode.order + 1;
  const previousEpisode = project.episodes[episode.order - 1];
  const nextEpisode = project.episodes[episode.order + 1];
  const serialPrompt = `你是一名专业短剧编剧。请为一部${toneLabels[meta.serialTone] || "短剧"}创作第 ${episodeNumber} 集的分镜脚本，共 ${episode.meta.shotCount} 个镜头。

【项目级设定】
片名：${meta.title}
全剧梗概：${meta.synopsis}
类型与基调：${meta.genre} / ${meta.serialTone}
固定角色：${meta.character || "待定"}
统一视觉风格：${meta.visualStyle || "现代电影质感"}

【本集设定】
本集标题：${episode.meta.title}
本集梗概：${episode.meta.synopsis || "根据全剧梗概推进"}
叙事目标：${episode.meta.objective || "推进主线与人物关系"}
开场钩子：${episode.meta.hook || "前几个镜头迅速建立冲突"}
高潮与结尾：${episode.meta.ending || "形成高潮，并留下下一集悬念"}
上一集：${previousEpisode ? `${previousEpisode.meta.title}；${previousEpisode.meta.ending || previousEpisode.meta.synopsis}` : "无，这是开篇"}
下一集：${nextEpisode ? nextEpisode.meta.title : "未设定或全剧收束"}

返回严格的 JSON，格式如下（不要 markdown 围栏）：
{
  "startKey": "shot_1",
  "scenes": [
    {
      "key": "shot_1",
      "episodeOrder": 1,
      "title": "开场钩子",
      "shot": "大全景",
      "duration": 8,
      "action": "场景描述与表演",
      "dialogue": "对白或旁白",
      "transition": "match",
      "entryState": "本镜开始时的人物姿势、视线、位置、道具与情绪",
      "exitState": "本镜结束时留给下一镜的人物姿势、视线、位置、道具与情绪",
      "nextKey": "shot_2"
    }
  ]
}

要求：
1. 严格返回 ${episode.meta.shotCount} 个镜头，镜头之间线性连接，最后一个镜头 nextKey 为空字符串。
2. 先在内部把本集拆成 ${episode.meta.shotCount} 个连续节拍，再逐镜输出；每个镜头只发生一个不可再分的事件或表演动作，禁止在任一 action 中复述本集梗概、叙事目标或完整结局。
3. 每镜 action 只描述该镜头可见的动作、表情、空间变化与即时结果，不写后续镜头内容，不使用“随后、接着、最终”等跨镜头概括。
4. dialogue 只包含当前镜头实际说出的对白或旁白，不得朗读 action 或剧情梗概。按每秒最多约 3 个中文字计算：4秒不超过7字、6秒不超过13字、8秒不超过19字、10秒不超过25字、12秒不超过31字、15秒不超过40字；需要更多对白时必须拆到后续镜头。
5. 人物身份、服装、地点状态和情绪在相邻镜头间连续，但连续性信息不得替代当前镜头事件。
6. 每镜必须给出 entryState 与 exitState；第 N 镜的 exitState 必须能直接成为第 N+1 镜的 entryState。保持人物屏幕方向、动作方向、视线、手中道具、环境光线和声音底噪连续。
7. transition 只能是 match、dissolve、cut、fade；同一场景连续动作优先 match，时间或地点轻微变化用 dissolve，强烈段落转换才用 cut 或 fade。`;

  try {
    const result = await requestJson("/api/generate-episode", { method: "POST", body: JSON.stringify({
      model: provider.model,
      text_base_url: provider.baseUrl,
      text_api_key: provider.apiKey,
      prompt: serialPrompt,
    }), signal });
    installGeneratedSerial(parseStoryJson(result), meta, episode);
  } catch (error) {
    if (error.name === "AbortError") showToast("已取消文本模型生成。");
    else showToast(formatTextGenError(error), true);
  } finally {
    cancelTextGen(button, originalText);
    button.disabled = false;
  }
}

export function installGeneratedSerial(generated, meta, episode) {
  if (!generated || !Array.isArray(generated.scenes) || !generated.scenes.length) {
    throw new Error("文本模型没有返回 scenes 数组。");
  }
  if (generated.scenes.length > 200) throw new Error("文本模型返回超过 200 个镜头，已拒绝导入。");
  const keys = new Set();
  generated.scenes.forEach((item, index) => {
    const key = String(item?.key || `n${index}`);
    if (keys.has(key)) throw new Error(`重复节点 key：${key}`);
    keys.add(key);
  });
  const episodeNumber = episode.order + 1;
  const scenes = generated.scenes.map((item, index) => {
    const dialogue = String(item.dialogue || "").slice(0, 3000);
    const requestedDuration = [4, 6, 8, 10, 12, 15].includes(Number(item.duration)) ? Number(item.duration) : 8;
    const fittedDuration = spokenCharacterCount(dialogue) > dialogueBudget(requestedDuration)
      ? recommendedDialogueDuration(dialogue)
      : requestedDuration;
    return createScene({
    order: index,
    title: String(item.title || `镜头 ${index + 1}`).slice(0, 80),
    shot: ["大全景", "全景", "中景", "近景", "特写"].includes(item.shot) ? item.shot : "中景",
    duration: fittedDuration,
    action: String(item.action || "").slice(0, 6000),
    dialogue,
    transition: ["match", "dissolve", "cut", "fade"].includes(item.transition) ? item.transition : (index ? "match" : "cut"),
    entryState: String(item.entryState || "").slice(0, 1000),
    exitState: String(item.exitState || "").slice(0, 1000),
    episode: episodeNumber,
    episodeOrder: Number(item.episodeOrder) || (index + 1),
    choices: [],
    });
  });
  const idByKey = new Map(generated.scenes.map((item, index) => [String(item?.key || `n${index}`), scenes[index].id]));
  generated.scenes.forEach((item, index) => {
    scenes[index].nextSceneId = idByKey.get(String(item?.nextKey || "")) || "";
    scenes[index].imagePrompt = composeImagePrompt(scenes[index]);
    scenes[index].videoPrompt = composeVideoPrompt(scenes[index]);
  });
  const startId = idByKey.get(String(generated.startKey || generated.scenes[0]?.key || "")) || scenes[0].id;
  const seriesMaster = firstEpisodeMasterScene();
  scenes.forEach((scene) => {
    scene.referenceSceneId = scene.id === startId
      ? (episode.order > 0 && seriesMaster?.id !== scene.id ? seriesMaster?.id || "" : "")
      : startId;
  });
  project.meta = meta;
  project.scenes = scenes;
  project.startSceneId = startId;
  project.selectedSceneId = startId;
  normalizeSceneOrder();
  rebuildSerialTransitions();
  saveProject(); render();
  showToast(`“${episode.meta.title}”已生成 ${scenes.length} 个镜头。`);
}

// ─────────────────────────────────────────────
//  互动影游生成
// ─────────────────────────────────────────────
export async function generateStoryDraft() {
  const button = $("#draftBtn");
  const originalText = "使用文本模型生成";
  if (isTextGenRunning()) { cancelTextGen(button, originalText); return; }
  if (currentMode === "serial") { await generateSerialDraft(); return; }
  await Promise.resolve();
  const request = draftRequestMeta();
  if (!request || !confirmDraftReplacement()) return;
  const { meta, nodeCount } = request;
  const totalShots = nodeCount * (meta.interactiveShotsPerNode || 1);
  if (totalShots > 30 && !confirm(`本次将生成 ${totalShots} 个分镜（${nodeCount} 个剧情节点 × ${meta.interactiveShotsPerNode || 1} 镜/节点）。\n大规模生成可能需要 5-15 分钟，推理模型（如 MiniMax-M2.7）耗时更长。\n\n确定继续吗？`)) return;
  saveProviderSecrets();
  const provider = providerSettings("text");
  const signal = startTextGenProgress(button, originalText);
  try {
    const result = await requestJson("/api/generate-story", { method: "POST", body: JSON.stringify({
      model: provider.model,
      text_base_url: provider.baseUrl,
      text_api_key: provider.apiKey,
      title: meta.title,
      synopsis: meta.synopsis,
      genre: meta.genre,
      character: meta.character,
      visual_style: meta.visualStyle,
      tree_depth: meta.treeDepth,
      branch_count: meta.branchCount,
      shots_per_node: meta.interactiveShotsPerNode || 1,
    }), signal });
    installGeneratedStory(parseStoryJson(result), meta, nodeCount);
  } catch (error) {
    if (error.name === "AbortError") showToast("已取消文本模型生成。");
    else showToast(formatTextGenError(error), true);
  } finally {
    cancelTextGen(button, originalText);
    button.disabled = nodeCount > 240;
  }
}

export async function testTextProvider() {
  saveProject(); saveProviderSecrets();
  const meta = readMetaFromForm();
  const provider = providerSettings("text");
  const button = $("#testTextProviderBtn");
  button.disabled = true; button.textContent = "连接测试中…";
  try {
    const result = await requestJson("/api/test-text-provider", { method: "POST", body: JSON.stringify({
      text_base_url: provider.baseUrl, text_api_key: provider.apiKey, model: provider.model,
    }) });
    showToast(`文本模型连接成功：${result.model} · 后端 ${result.version}`);
  } catch (error) { showToast(`文本模型连接失败：${error.message}`, true); }
  finally { button.disabled = false; button.textContent = "测试文本模型连接"; }
}

export async function testImageProvider() {
  saveProject(); saveProviderSecrets();
  const meta = readMetaFromForm();
  const provider = providerSettings("image");
  const button = $("#testImageProviderBtn");
  if (!button) return;
  button.disabled = true; button.textContent = "连接测试中…";
  try {
    const result = await requestJson("/api/test-image-provider", { method: "POST", body: JSON.stringify({
      image_base_url: provider.baseUrl, image_api_key: provider.apiKey,
      image_model: provider.model, image_provider: provider.provider,
    }) });
    showToast(`文生图连接成功：${result.label}（连通且鉴权通过）· 后端 ${result.version}`);
  } catch (error) { showToast(`文生图连接失败：${error.message}`, true); }
  finally { button.disabled = false; button.textContent = "测试文生图连接"; }
}

export async function testVideoProvider() {
  saveProject(); saveProviderSecrets();
  const meta = readMetaFromForm();
  const provider = providerSettings("video");
  const button = $("#testVideoProviderBtn");
  if (!button) return;
  button.disabled = true; button.textContent = "连接测试中…";
  try {
    const result = await requestJson("/api/test-video-provider", { method: "POST", body: JSON.stringify({
      video_base_url: provider.baseUrl, video_api_key: provider.apiKey,
      video_model: provider.model, video_provider: provider.provider,
    }) });
    showToast(`图生视频连接成功：${result.label}（连通且鉴权通过）· 后端 ${result.version}`);
  } catch (error) { showToast(`图生视频连接失败：${error.message}`, true); }
  finally { button.disabled = false; button.textContent = "测试图生视频连接"; }
}

export function installGeneratedStory(generated, meta, expectedNodes) {
  if (!generated || !Array.isArray(generated.scenes) || !generated.scenes.length) throw new Error("文本模型没有返回 scenes 数组。");
  if (generated.scenes.length > 240) throw new Error("文本模型返回超过 240 个分镜，已拒绝导入。");
  const keys = new Set();
  generated.scenes.forEach((item, index) => {
    const key = String(item?.key || `n${index}`);
    if (keys.has(key)) throw new Error(`文本模型返回了重复节点 key：${key}`);
    keys.add(key);
  });
  generated.scenes.forEach((item) => {
    (Array.isArray(item?.choices) ? item.choices : []).forEach((choice) => {
      const targetKey = String(choice?.targetKey || "");
      if (!targetKey || !keys.has(targetKey)) throw new Error(`文本模型返回了无效的选择目标：${targetKey || "空值"}`);
    });
  });
  const scenes = generated.scenes.map((item, index) => createScene({
    order: index,
    title: String(item.title || `剧情节点 ${index + 1}`).slice(0, 80),
    shot: ["大全景", "全景", "中景", "近景", "特写"].includes(item.shot) ? item.shot : "中景",
    duration: [4, 6, 8, 10, 12, 15].includes(Number(item.duration)) ? Number(item.duration) : 8,
    action: String(item.action || "").slice(0, 6000),
    dialogue: String(item.dialogue || "").slice(0, 3000),
    storyNodeKey: String(item.storyNodeKey || ""),
    shotInNode: Number(item.shotInNode) || 1,
    shotsInNode: Number(item.shotsInNode) || 1,
  }));
  const idByKey = new Map(generated.scenes.map((item, index) => [String(item?.key || `n${index}`), scenes[index].id]));
  generated.scenes.forEach((item, index) => {
    const scene = scenes[index];
    scene.choices = (Array.isArray(item.choices) ? item.choices : []).map((choice) => ({
      id: choiceUid(), text: String(choice?.text || "未命名选择").slice(0, 100),
      effect: String(choice?.effect || "").slice(0, 180),
      targetSceneId: idByKey.get(String(choice?.targetKey || "")) || "",
    }));
    scene.nextSceneId = idByKey.get(String(item?.nextKey || "")) || "";
  });
  let finalScenes = scenes;
  let finalStartId = idByKey.get(String(generated.startKey || generated.scenes[0]?.key || "")) || scenes[0].id;
  const shotsPerNode = meta.interactiveShotsPerNode || 1;
  const storyNodeCount = expectedNodes / shotsPerNode;
  if (shotsPerNode > 1 && scenes.length === storyNodeCount) {
    const expanded = expandInteractiveStoryScenes(scenes, idByKey, shotsPerNode);
    finalScenes = expanded.scenes;
    finalStartId = expanded.startIdByKey.get(String(generated.startKey || generated.scenes[0]?.key || "")) || finalScenes[0].id;
  }
  finalScenes.forEach((scene) => {
    scene.imagePrompt = composeImagePrompt(scene);
    scene.videoPrompt = composeVideoPrompt(scene);
    scene.referenceSceneId = scene.id === finalStartId ? "" : finalStartId;
  });
  project.meta = meta;
  project.scenes = finalScenes;
  project.startSceneId = finalStartId;
  project.selectedSceneId = finalStartId;
  normalizeSceneOrder();
  saveProject(); render();
  const mismatch = finalScenes.length === expectedNodes ? "" : `，模型实际返回 ${finalScenes.length}/${expectedNodes} 个分镜`;
  showToast(`文本模型剧情草案已生成${mismatch}。`);
}
