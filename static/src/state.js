// ─────────────────────────────────────────────
//  全局常量
// ─────────────────────────────────────────────
export const STORAGE_KEY = "frameforge-project-v1";
export const RECOVERY_KEY = "frameforge-project-recovery-v1";
export const SECRET_STORAGE_KEY = "frameforge-provider-secrets-v1";
export const DEFAULT_MODELS = {
  textBaseUrl: "https://api.atlascloud.ai/v1",
  textModel: "deepseek-v3",
  imageBaseUrl: "https://api.atlascloud.ai/api/v1/model",
  imageModel: "openai/gpt-image-2/text-to-image",
  imageEditModel: "openai/gpt-image-2/edit",
  videoBaseUrl: "https://api.atlascloud.ai/api/v1/model",
  videoModel: "xai/grok-imagine-video-v1.5/image-to-video",
};
export const TEXT_GEN_TIMEOUT_MS = 900_000; // 15 分钟上限

export const $ = (selector) => document.querySelector(selector);

// ─────────────────────────────────────────────
//  DOM 元素缓存
//  说明：原实现在脚本顶层直接抓取节点。打包后入口在 DOMContentLoaded
//  之后执行，所以改为惰性初始化，由 main.js 在启动时调用 initElements()。
// ─────────────────────────────────────────────
export const elements = {};

export function initElements() {
  Object.assign(elements, {
    projectTitle: $("#projectTitle"), projectSynopsis: $("#projectSynopsis"),
    projectGenre: $("#projectGenre"), projectAspect: $("#projectAspect"),
    projectStyle: $("#projectStyle"), projectCharacter: $("#projectCharacter"),
    projectTreeDepth: $("#projectTreeDepth"), projectBranchCount: $("#projectBranchCount"),
    projectInteractiveShotsPerNode: $("#projectInteractiveShotsPerNode"),
    projectTextModel: $("#projectTextModel"), projectImageModel: $("#projectImageModel"),
    projectVideoModel: $("#projectVideoModel"), projectImageEditModel: $("#projectImageEditModel"),
    projectTextBaseUrl: $("#projectTextBaseUrl"), projectImageBaseUrl: $("#projectImageBaseUrl"),
    projectVideoBaseUrl: $("#projectVideoBaseUrl"), projectTextApiKey: $("#projectTextApiKey"),
    projectImageApiKey: $("#projectImageApiKey"), projectVideoApiKey: $("#projectVideoApiKey"),
    projectImageProvider: $("#projectImageProvider"), projectVideoProvider: $("#projectVideoProvider"),
    sceneList: $("#sceneList"), sceneEditor: $("#sceneEditor"), emptyState: $("#emptyState"),
    sceneTitle: $("#sceneTitle"), sceneShot: $("#sceneShot"), sceneDuration: $("#sceneDuration"),
    sceneAction: $("#sceneAction"), sceneDialogue: $("#sceneDialogue"),
    sceneTransition: $("#sceneTransition"), sceneEntryState: $("#sceneEntryState"), sceneExitState: $("#sceneExitState"),
    sceneNext: $("#sceneNext"), choiceList: $("#choiceList"),
    sceneReference: $("#sceneReference"), referenceStatus: $("#referenceStatus"),
    sceneImagePrompt: $("#sceneImagePrompt"), sceneVideoPrompt: $("#sceneVideoPrompt"),
    imageCard: $("#imageCard"), videoCard: $("#videoCard"), toast: $("#toast"),
    storyModal: $("#storyModal"), storyPlayer: $("#storyPlayer"), playerStage: $("#playerStage"),
    serialModal: $("#serialModal"), serialPlayer: $("#serialPlayer"), serialStage: $("#serialStage"),
    treeModal: $("#treeModal"), treeBrowser: $("#treeBrowser"), treeViewport: $("#treeViewport"),
    treeCanvas: $("#treeCanvas"), treeEdges: $("#treeEdges"), treeNodes: $("#treeNodes"),
    episodeList: $("#episodeList"), episodeTitle: $("#episodeTitle"),
    episodeSynopsis: $("#episodeSynopsis"), episodeObjective: $("#episodeObjective"),
    episodeHook: $("#episodeHook"), episodeEnding: $("#episodeEnding"),
    episodeShotCount: $("#episodeShotCount"), episodeSettings: $("#episodeSettings"),
    mediaPreviewModal: $("#mediaPreviewModal"), mediaPreviewStage: $("#mediaPreviewStage"),
  });
}

// ─────────────────────────────────────────────
//  跨模块可变状态
//  原实现是顶层 let/可重新赋值的变量。打包成 ESM 后，import 绑定是只读的，
//  无法跨模块重新赋值，因此用「getter + setter」封装：读取仍用同名导出（实时绑定），
//  重新赋值改为调用 setXxx()。
// ─────────────────────────────────────────────
export let currentMode = "interactive";
export function setCurrentMode(value) { currentMode = value; }

export let project = null;
export function setProject(value) { project = value; }

export let toastTimer;
export function setToastTimer(value) { toastTimer = value; }

export let playerState = { sceneId: null, history: [], startSceneId: null, autoTimer: null };
export function setPlayerState(value) { playerState = value; }

export let serialState = { index: 0, autoPlay: false, autoTimer: null };
export function setSerialState(value) { serialState = value; }

export const activeTasks = new Map();

export let treeZoom = 1;
export function setTreeZoomValue(value) { treeZoom = value; }

export let draggedSceneId = null;
export function setDraggedSceneId(value) { draggedSceneId = value; }

export let draggedSceneSource = "";
export function setDraggedSceneSource(value) { draggedSceneSource = value; }

export let draggedEpisodeId = null;
export function setDraggedEpisodeId(value) { draggedEpisodeId = value; }

export const treePanState = { active: false, startX: 0, startY: 0, panX: 0, panY: 0, originPanX: 0, originPanY: 0 };

// 文本生成进度管理状态
export let textGenController = null;
export function setTextGenController(value) { textGenController = value; }

export let textGenTimer = null;
export function setTextGenTimer(value) { textGenTimer = value; }
