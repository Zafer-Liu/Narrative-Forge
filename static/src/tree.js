import {
  $, elements, currentMode, project,
  treeZoom, setTreeZoomValue, treePanState,
} from "./state.js";
import { escapeHtml, showToast } from "./utils.js";
import { orderedScenes, activeEpisode, saveProject, readMetaFromForm, findSceneAcrossProject } from "./project-model.js";
import { interactiveStoryGroups, storyNodeTitle, storyTargets } from "./story-graph.js";
import { syncEditorToScene, renderEditor, render } from "./render.js";
import { proxyMediaUrl } from "./api.js";

// 模块级拖动 / 渲染状态（声明提前，供 renderTreeBrowser 与拖动逻辑共享）
let treeDragState = null;
// 拖拽结束后短暂置位，吞掉随之而来的 click，避免误触选中/重渲染
let treeJustDragged = false;
// 当前渲染上下文（供拖动时增量重绘连线）
let treeRenderContext = null;
// 增量渲染：sceneId/groupId → 已创建的节点元素，跨次渲染复用，避免整树 innerHTML 重建
const treeNodeEls = new Map();

// 是否把同一剧情节点的多个分镜合并成一个剧情节点来展示。
// 默认 true = 合并：剧情树以「剧情节点」为单位呈现（一组分镜=一个节点），
// 节点之间按剧情走向连线。可选展开为单分镜视图。
export function treeShotsMerged() {
  return project?.meta?.treeMergeShots !== false;
}

export function buildTreeLayout() {
  const sourceGroups = interactiveStoryGroups();
  const shouldGroup = treeShotsMerged() && sourceGroups.some((group) => group.scenes.length > 1);
  if (shouldGroup) return buildGroupedTreeLayout(sourceGroups);

  const byId = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const depthById = new Map();
  const queue = project.startSceneId ? [{ id: project.startSceneId, depth: 0 }] : [];
  while (queue.length) {
    const current = queue.shift();
    if (!byId.has(current.id)) continue;
    if (depthById.has(current.id) && depthById.get(current.id) <= current.depth) continue;
    depthById.set(current.id, current.depth);
    storyTargets(byId.get(current.id)).forEach((target) => queue.push({ id: target.id, depth: current.depth + 1 }));
  }
  const maxReachableDepth = Math.max(0, ...depthById.values());
  orderedScenes().forEach((scene) => { if (!depthById.has(scene.id)) depthById.set(scene.id, maxReachableDepth + 1); });
  const levels = [];
  orderedScenes().forEach((scene) => {
    const depth = depthById.get(scene.id);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(scene);
  });
  return { byId, depthById, levels };
}

export function buildGroupedTreeLayout(sourceGroups) {
  const sceneToGroupId = new Map();
  const nodes = sourceGroups.map((group) => {
    const groupId = `story:${group.key}`;
    group.scenes.forEach((scene) => sceneToGroupId.set(scene.id, groupId));
    const first = group.scenes[0];
    const tail = group.scenes[group.scenes.length - 1];
    // 缩略图取本组第一个已有关键帧的镜头（优先首镜）
    const thumbScene = group.scenes.find((scene) => scene.imageLocalUrl || scene.imageUrl) || first;
    return {
      id: groupId,
      selectSceneId: first.id,
      sceneIds: group.scenes.map((scene) => scene.id),
      title: storyNodeTitle(first),
      shotCount: group.scenes.length,
      choices: [],
      nextSceneId: "",
      imageCount: group.scenes.filter((scene) => scene.imageUrl || scene.imageLocalUrl).length,
      videoCount: group.scenes.filter((scene) => scene.videoUrl || scene.videoLocalUrl).length,
      imageStatus: group.scenes.some((scene) => scene.imageStatus === "working") ? "working" : "",
      videoStatus: group.scenes.some((scene) => scene.videoStatus === "working") ? "working" : "",
      imageLocalUrl: thumbScene.imageLocalUrl || "",
      imageUrl: thumbScene.imageUrl || "",
      tail,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => {
    node.choices = (node.tail.choices || []).map((choice) => ({
      ...choice,
      targetSceneId: sceneToGroupId.get(choice.targetSceneId) || choice.targetSceneId,
    }));
    node.nextSceneId = sceneToGroupId.get(node.tail.nextSceneId) || node.tail.nextSceneId || "";
  });
  const depthById = new Map();
  const startGroupId = sceneToGroupId.get(project.startSceneId) || nodes[0]?.id || "";
  const queue = startGroupId ? [{ id: startGroupId, depth: 0 }] : [];
  while (queue.length) {
    const current = queue.shift();
    if (!byId.has(current.id)) continue;
    if (depthById.has(current.id) && depthById.get(current.id) <= current.depth) continue;
    depthById.set(current.id, current.depth);
    storyTargets(byId.get(current.id)).forEach((target) => queue.push({ id: target.id, depth: current.depth + 1 }));
  }
  const maxReachableDepth = Math.max(0, ...depthById.values());
  nodes.forEach((node) => { if (!depthById.has(node.id)) depthById.set(node.id, maxReachableDepth + 1); });
  const levels = [];
  nodes.forEach((node) => {
    const depth = depthById.get(node.id);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(node);
  });
  return { byId, depthById, levels, nodes, grouped: true };
}

export function buildSerialTreeLayout() {
  const byId = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const episodes = [...new Set(orderedScenes().map((s) => s.episode || 1))].sort((a, b) => a - b);
  const levels = episodes.map((ep) => orderedScenes()
    .filter((s) => (s.episode || 1) === ep)
    .sort((a, b) => (a.episodeOrder || 0) - (b.episodeOrder || 0)));
  const depthById = new Map();
  levels.forEach((level, depth) => level.forEach((scene) => depthById.set(scene.id, depth)));
  orderedScenes().forEach((scene, index) => { if (!depthById.has(scene.id)) depthById.set(scene.id, index); });
  return { byId, depthById, levels };
}

export function openTreeBrowser() {
  syncEditorToScene();
  if (!project.scenes.length) return showToast("当前项目没有剧情节点。", true);
  setTreeZoomValue(1);
  treePanState.panX = 0;
  treePanState.panY = 0;
  // 重置增量渲染缓存，避免上一个项目/上一次会话的残留节点
  treeNodeEls.clear();
  if (elements.treeNodes) elements.treeNodes.innerHTML = "";
  elements.treeModal.hidden = false;
  document.body.classList.add("modal-open");
  $("#treeBrowserTitle").textContent = `${readMetaFromForm().title} · ${currentMode === "serial" ? `${activeEpisode()?.meta.title || "当前集"}结构` : "剧情树"}`;
  $("#treeBrowserMode").textContent = currentMode === "serial" ? "AI 短剧" : "剧情结构";
  updateTreeToggleShotsButton();
  renderTreeBrowser();
  setupTreePan();
  setupTreeNodeDrag();
}

// 仅当互动模式存在「多分镜剧情节点」时才显示「展开/合并分镜」开关
function updateTreeToggleShotsButton() {
  const btn = $("#treeToggleShotsBtn");
  if (!btn) return;
  const hasMultiShot = currentMode !== "serial"
    && interactiveStoryGroups().some((group) => group.scenes.length > 1);
  btn.hidden = !hasMultiShot;
  btn.textContent = treeShotsMerged() ? "展开分镜" : "合并分镜";
}

export function toggleTreeShots() {
  project.meta.treeMergeShots = !treeShotsMerged();
  saveProject();
  updateTreeToggleShotsButton();
  renderTreeBrowser();
  showToast(treeShotsMerged() ? "已合并同一剧情节点的分镜。" : "已展开每个分镜为独立节点并连线。");
}

export function closeTreeBrowser() {
  if (document.fullscreenElement === elements.treeBrowser) document.exitFullscreen().catch(() => {});
  closeTreeDetail();
  elements.treeModal.hidden = true;
  document.body.classList.remove("modal-open");
  renderEditor();
}

// ─────────────────────────────────────────────
//  剧情树节点详情面板：显示该剧情节点的所有分镜，逐镜播放视频 / 关键帧
// ─────────────────────────────────────────────
let treeDetailShots = [];   // 当前节点的分镜列表（按顺序）
let treeDetailIndex = 0;    // 当前查看的分镜下标
let treeDetailPlayAll = false;

// 取得某个分镜所属「剧情节点」的全部分镜（按顺序）。
// 互动模式：同一 storyNodeKey 的分镜归为一组；短剧/无分组：仅自身。
function shotsOfNode(sceneId) {
  if (currentMode !== "serial") {
    const groups = interactiveStoryGroups();
    for (const group of groups) {
      if (group.scenes.some((s) => s.id === sceneId)) return group.scenes.slice();
    }
  }
  const single = project.scenes.find((s) => s.id === sceneId) || findSceneAcrossProject(sceneId);
  return single ? [single] : [];
}

export function openTreeDetail(sceneId) {
  const panel = $("#treeDetail");
  if (!panel) return;
  treeDetailShots = shotsOfNode(sceneId);
  if (!treeDetailShots.length) return;
  // 定位到点击的那一镜（分组节点点击落在首镜，但仍从第 1 镜开始）
  const clickedIdx = treeDetailShots.findIndex((s) => s.id === sceneId);
  treeDetailIndex = clickedIdx >= 0 ? clickedIdx : 0;
  treeDetailPlayAll = false;
  panel.hidden = false;
  elements.treeBrowser?.classList.add("detail-open");
  renderTreeDetailShot();
}

function renderTreeDetailShot() {
  const scene = treeDetailShots[treeDetailIndex];
  if (!scene) return;
  const total = treeDetailShots.length;

  const tag = $("#treeDetailTag");
  if (tag) {
    tag.textContent = currentMode === "serial"
      ? `第${scene.episode || 1}集 · 第${scene.episodeOrder || 1}镜`
      : (total > 1 ? `剧情节点 · 共 ${total} 分镜` : "剧情节点");
  }
  $("#treeDetailTitle").textContent = scene.title || "未命名镜头";
  $("#treeDetailAction").textContent = scene.action || "（暂无剧情描述）";
  const dialogue = (scene.dialogue || "").trim();
  $("#treeDetailDialogueWrap").hidden = !dialogue;
  $("#treeDetailDialogue").textContent = dialogue;

  // 多分镜时显示分镜导航栏 + 缩略图条
  const nav = $("#treeDetailNav");
  const shotsBar = $("#treeDetailShots");
  if (total > 1) {
    nav.hidden = false;
    shotsBar.hidden = false;
    $("#treeDetailShotPos").textContent = `分镜 ${treeDetailIndex + 1} / ${total}`;
    $("#treeDetailPrevBtn").disabled = treeDetailIndex <= 0;
    $("#treeDetailNextBtn").disabled = treeDetailIndex >= total - 1;
    $("#treeDetailPlayAllBtn").textContent = treeDetailPlayAll ? "⏸ 停止连播" : "▶ 连续播放";
    renderTreeDetailShotStrip();
  } else {
    nav.hidden = true;
    shotsBar.hidden = true;
  }

  // 媒体：优先视频，其次关键帧，再次占位
  const stage = $("#treeDetailStage");
  stopTreeDetailVideo();
  stage.innerHTML = "";
  const videoUrl = scene.videoLocalUrl || (scene.videoUrl ? proxyMediaUrl(scene.videoUrl) : "");
  const imageUrl = scene.imageLocalUrl || (scene.imageUrl ? proxyMediaUrl(scene.imageUrl) : "");
  if (videoUrl) {
    const video = document.createElement("video");
    video.src = videoUrl; video.controls = true; video.playsInline = true; video.preload = "metadata";
    if (imageUrl) video.poster = imageUrl;
    if (treeDetailPlayAll) {
      video.autoplay = true;
      video.addEventListener("ended", () => {
        if (treeDetailPlayAll && treeDetailIndex < treeDetailShots.length - 1) {
          treeDetailIndex += 1;
          renderTreeDetailShot();
        } else {
          treeDetailPlayAll = false;
          $("#treeDetailPlayAllBtn").textContent = "▶ 连续播放";
        }
      }, { once: true });
    }
    stage.appendChild(video);
  } else if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl; img.alt = scene.title || "关键帧";
    stage.appendChild(img);
    // 连播模式下，无视频的镜头按时长停留后自动进入下一镜
    if (treeDetailPlayAll && treeDetailIndex < treeDetailShots.length - 1) {
      treeDetailAutoTimer = setTimeout(() => {
        if (treeDetailPlayAll) { treeDetailIndex += 1; renderTreeDetailShot(); }
      }, (scene.duration || 6) * 1000);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "tree-detail-empty";
    empty.textContent = scene.imageStatus === "working" || scene.videoStatus === "working"
      ? "素材正在生成中…" : "该分镜尚未生成关键帧或视频";
    stage.appendChild(empty);
    if (treeDetailPlayAll && treeDetailIndex < treeDetailShots.length - 1) {
      treeDetailAutoTimer = setTimeout(() => {
        if (treeDetailPlayAll) { treeDetailIndex += 1; renderTreeDetailShot(); }
      }, 1500);
    }
  }

  const editBtn = $("#treeDetailEditBtn");
  if (editBtn) {
    editBtn.onclick = () => {
      project.selectedSceneId = scene.id;
      saveProject();
      closeTreeBrowser();
      render();
    };
  }
}

// 分镜缩略图条：点选任意分镜
function renderTreeDetailShotStrip() {
  const bar = $("#treeDetailShots");
  if (!bar) return;
  bar.innerHTML = "";
  treeDetailShots.forEach((shot, index) => {
    const cell = document.createElement("button");
    cell.className = `tree-detail-shot${index === treeDetailIndex ? " active" : ""}`;
    cell.title = shot.title || `分镜 ${index + 1}`;
    const thumbUrl = shot.imageLocalUrl || (shot.imageUrl ? proxyMediaUrl(shot.imageUrl) : "");
    if (thumbUrl) {
      const img = document.createElement("img");
      img.src = thumbUrl; img.alt = ""; img.loading = "lazy"; img.draggable = false;
      cell.appendChild(img);
    } else {
      cell.classList.add("empty");
      cell.textContent = String(index + 1);
    }
    if (shot.videoUrl || shot.videoLocalUrl) cell.classList.add("has-video");
    cell.addEventListener("click", () => {
      stopTreeDetailPlayback();
      treeDetailIndex = index;
      renderTreeDetailShot();
    });
    bar.appendChild(cell);
  });
}

function treeDetailGo(delta) {
  stopTreeDetailPlayback();
  const next = treeDetailIndex + delta;
  if (next < 0 || next >= treeDetailShots.length) return;
  treeDetailIndex = next;
  renderTreeDetailShot();
}

export function treeDetailPrev() { treeDetailGo(-1); }
export function treeDetailNext() { treeDetailGo(1); }

export function treeDetailTogglePlayAll() {
  if (treeDetailPlayAll) {
    stopTreeDetailPlayback();
    $("#treeDetailPlayAllBtn").textContent = "▶ 连续播放";
    return;
  }
  treeDetailPlayAll = true;
  // 从头连播
  treeDetailIndex = 0;
  renderTreeDetailShot();
}

let treeDetailAutoTimer = null;
function stopTreeDetailPlayback() {
  treeDetailPlayAll = false;
  if (treeDetailAutoTimer) { clearTimeout(treeDetailAutoTimer); treeDetailAutoTimer = null; }
}

function stopTreeDetailVideo() {
  if (treeDetailAutoTimer) { clearTimeout(treeDetailAutoTimer); treeDetailAutoTimer = null; }
  const video = $("#treeDetailStage")?.querySelector("video");
  if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
}

export function closeTreeDetail() {
  const panel = $("#treeDetail");
  if (!panel || panel.hidden) return;
  stopTreeDetailPlayback();
  stopTreeDetailVideo();
  panel.hidden = true;
  elements.treeBrowser?.classList.remove("detail-open");
}

// ─────────────────────────────────────────────
//  画布平移 + 缩放
//
//  原实现用 viewport.scrollLeft/scrollTop 平移 + 画布 CSS `zoom` 缩放。
//  在 Electron/Chromium 下 `zoom` 与滚动叠加会导致滚动条/坐标错乱，常表现为
//  “拖不动画板”。改为纯 CSS `transform: translate() scale()`：画布不再依赖滚动，
//  平移=改 translate，缩放=改 scale，与节点拖拽的屏幕坐标命中检测天然兼容。
// ─────────────────────────────────────────────
export function applyTreeTransform() {
  const canvas = elements.treeCanvas;
  if (!canvas) return;
  canvas.style.transform = `translate(${treePanState.panX}px, ${treePanState.panY}px) scale(${treeZoom})`;
}

export function setupTreePan() {
  const viewport = elements.treeViewport;
  if (viewport._panBound) return;
  viewport._panBound = true;

  const startPan = (clientX, clientY, target) => {
    if (target.closest(".tree-node")) return false;
    treePanState.active = true;
    treePanState.startX = clientX;
    treePanState.startY = clientY;
    treePanState.originPanX = treePanState.panX;
    treePanState.originPanY = treePanState.panY;
    viewport.style.cursor = "grabbing";
    return true;
  };

  viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (startPan(e.clientX, e.clientY, e.target)) e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!treePanState.active) return;
    treePanState.panX = treePanState.originPanX + (e.clientX - treePanState.startX);
    treePanState.panY = treePanState.originPanY + (e.clientY - treePanState.startY);
    applyTreeTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!treePanState.active) return;
    treePanState.active = false;
    viewport.style.cursor = "";
  });

  viewport.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startPan(e.touches[0].clientX, e.touches[0].clientY, e.target);
  }, { passive: true });

  viewport.addEventListener("touchmove", (e) => {
    if (!treePanState.active || e.touches.length !== 1) return;
    treePanState.panX = treePanState.originPanX + (e.touches[0].clientX - treePanState.startX);
    treePanState.panY = treePanState.originPanY + (e.touches[0].clientY - treePanState.startY);
    applyTreeTransform();
  }, { passive: true });

  viewport.addEventListener("touchend", () => { treePanState.active = false; }, { passive: true });

  viewport.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setTreeZoom(treeZoom + delta);
    }
  }, { passive: false });
}

export function renderTreeBrowser() {
  const layout = currentMode === "serial" ? buildSerialTreeLayout() : buildTreeLayout();
  const { byId, depthById, levels } = layout;

  const nodeWidth = currentMode === "serial" ? 220 : (layout.grouped ? 240 : 220);
  const nodeHeight = currentMode === "serial" ? 84 : (layout.grouped ? 92 : 80);
  const columnGap = currentMode === "serial" ? 60 : 90;
  const rowGap = 22;
  const padding = 50;

  const maxRows = Math.max(1, ...levels.map((level) => level?.length || 0));
  let canvasWidth = Math.max(720, padding * 2 + levels.length * nodeWidth + Math.max(0, levels.length - 1) * columnGap);
  let canvasHeight = Math.max(520, padding * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap);
  applyTreeTransform();
  const positions = new Map();
  // 自定义布局：用户拖动后保存的节点坐标（按当前模式存储）
  const savedLayout = treeLayoutMap();
  // 本次出现的节点 key 集合，用于增量回收（删除已不存在的旧节点）
  const seen = new Set();

  levels.forEach((levelScenes, depth) => {
    const scenes = levelScenes || [];
    const totalHeight = scenes.length * nodeHeight + Math.max(0, scenes.length - 1) * rowGap;
    const startY = Math.max(padding, (canvasHeight - totalHeight) / 2);
    scenes.forEach((scene, row) => {
      let x = padding + depth * (nodeWidth + columnGap);
      let y = startY + row * (nodeHeight + rowGap);
      const saved = savedLayout[scene.id];
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) { x = saved.x; y = saved.y; }
      positions.set(scene.id, { x, y });
      canvasWidth = Math.max(canvasWidth, x + nodeWidth + padding);
      canvasHeight = Math.max(canvasHeight, y + nodeHeight + padding);
      seen.add(scene.id);
      renderTreeNode(scene, { x, y, depth, row, nodeWidth, nodeHeight, layout });
    });
  });

  // 回收：移除本次不再出现的节点（增量删除，而非整树清空）
  treeNodeEls.forEach((el, key) => {
    if (!seen.has(key)) { el.remove(); treeNodeEls.delete(key); }
  });

  elements.treeCanvas.style.width = `${canvasWidth}px`;
  elements.treeCanvas.style.height = `${canvasHeight}px`;
  elements.treeEdges.setAttribute("width", canvasWidth);
  elements.treeEdges.setAttribute("height", canvasHeight);
  elements.treeEdges.setAttribute("viewBox", `0 0 ${canvasWidth} ${canvasHeight}`);

  // 暂存渲染上下文，供拖动时实时重绘连线（避免整树重渲染）
  treeRenderContext = { layout, positions, byId, nodeWidth, nodeHeight, canvasWidth, canvasHeight };
  drawTreeEdges();

  const treeScenes = layout.nodes || project.scenes;
  const endings = treeScenes.filter((scene) => !scene.nextSceneId && !scene.choices.length).length;
  if (currentMode === "serial") {
    $("#treeStats").textContent = `${activeEpisode()?.meta.title || "当前集"} · ${project.scenes.length} 镜头`;
  } else {
    const storyNodes = new Set(project.scenes.map((scene) => scene.storyNodeKey || scene.id)).size;
    $("#treeStats").textContent = storyNodes < project.scenes.length
      ? `${storyNodes} 剧情节点 · ${project.scenes.length} 分镜 · ${endings} 结局`
      : `${project.scenes.length} 节点 · ${endings} 结局`;
  }
  $("#treeZoomResetBtn").textContent = `${Math.round(treeZoom * 100)}%`;
}

// 增量创建或更新单个节点：复用已存在的 DOM（按 scene.id 缓存），只改动变化的属性，
// 避免每次渲染都重建所有节点与重新绑定事件。
function renderTreeNode(scene, ctx) {
  const { x, y, nodeWidth, nodeHeight, layout } = ctx;
  const isEnding = !scene.nextSceneId && !scene.choices.length;
  const isSerial = currentMode === "serial";
  const isGrouped = Boolean(layout.grouped);
  const isStart = isGrouped ? scene.sceneIds.includes(project.startSceneId) : scene.id === project.startSceneId;
  const isSelected = isGrouped ? scene.sceneIds.includes(project.selectedSceneId) : scene.id === project.selectedSceneId;

  let node = treeNodeEls.get(scene.id);
  const isNew = !node;
  if (isNew) {
    node = document.createElement("button");
    node.draggable = false;
    node.dataset.sceneId = scene.id;
    const thumb = document.createElement("span");
    thumb.className = "tree-node-thumb";
    const body = document.createElement("span");
    body.className = "tree-node-body";
    node.append(thumb, body);
    // 事件只在创建时绑定一次；通过 node._selectSceneId 读取当前身份
    node.addEventListener("click", () => {
      if (treeJustDragged) return;
      const targetId = node._selectSceneId || node.dataset.sceneId;
      syncEditorToScene();
      project.selectedSceneId = targetId;
      saveProject();
      renderEditor();
      updateTreeSelection();          // 仅更新选中态，不整树重建
      openTreeDetail(targetId);
    });
    node.addEventListener("dblclick", () => {
      const targetId = node._selectSceneId || node.dataset.sceneId;
      syncEditorToScene();
      project.selectedSceneId = targetId;
      saveProject();
      closeTreeBrowser();
      render();
    });
    bindTreeNodePointerDrag(node, scene.id, { nodeWidth, nodeHeight });
    treeNodeEls.set(scene.id, node);
    elements.treeNodes.appendChild(node);
  }
  node._selectSceneId = scene.selectSceneId || scene.id;

  const className = [
    "tree-node",
    isStart ? "start" : "",
    isEnding && !isSerial ? "ending" : "",
    isSerial ? "serial-node" : "",
    isGrouped ? "grouped-node" : "",
    isSelected ? "selected" : "",
  ].filter(Boolean).join(" ");
  if (node.className !== className) node.className = className;
  node._selected = isSelected;

  const title = isGrouped
    ? "拖动可自由摆放；单击查看剧情与视频，双击返回编辑器"
    : "拖动可自由摆放；单击查看剧情与视频，双击进入编辑";
  if (node.title !== title) node.title = title;
  node.style.left = `${x}px`; node.style.top = `${y}px`;
  node.style.width = `${nodeWidth}px`; node.style.height = `${nodeHeight}px`;

  const imgDot = (scene.imageUrl || scene.imageLocalUrl) ? "●" : "○";
  const vidDot = (scene.videoUrl || scene.videoLocalUrl) ? "●" : "○";
  const assetStatusClass = (scene.imageStatus === "working" || scene.videoStatus === "working") ? " node-generating" : "";
  const thumbUrl = scene.imageLocalUrl || (scene.imageUrl ? proxyMediaUrl(scene.imageUrl) : "");
  const hasVideo = Boolean(scene.videoUrl || scene.videoLocalUrl);

  // 缩略图：仅当签名变化时才重建（避免重复加载导致闪烁）
  const thumb = node.firstChild;
  const thumbSig = `${thumbUrl}|${hasVideo}|${scene.imageStatus}`;
  if (thumb._sig !== thumbSig) {
    thumb._sig = thumbSig;
    thumb.className = `tree-node-thumb${hasVideo ? " has-video" : ""}`;
    thumb.innerHTML = "";
    if (thumbUrl) {
      const img = document.createElement("img");
      img.src = thumbUrl; img.alt = ""; img.loading = "lazy"; img.draggable = false;
      thumb.appendChild(img);
    } else {
      thumb.classList.add("empty");
      thumb.textContent = scene.imageStatus === "working" ? "⏳" : "无帧";
    }
  }

  // 文本体：仅当签名变化时才重写 innerHTML
  const body = node.lastChild;
  let html;
  if (isSerial) {
    const epLabel = `第${scene.episode || 1}集 · ${scene.episodeOrder || 1}`;
    html = `<small class="node-ep-label">${epLabel}</small><strong>${escapeHtml(scene.title)}</strong><span class="node-assets${assetStatusClass}"><span class="asset-icon img">${imgDot}</span>图 <span class="asset-icon vid">${vidDot}</span>视频</span>`;
  } else if (isGrouped) {
    const label = isStart ? `起点 · ${scene.shotCount} 分镜` : isEnding ? `结局 · ${scene.shotCount} 分镜` : `${scene.choices.length || 1} 条走向 · ${scene.shotCount} 分镜`;
    html = `<small>${label}</small><strong>${escapeHtml(scene.title)}</strong><span class="node-assets${assetStatusClass}">图 ${scene.imageCount}/${scene.shotCount} · 视频 ${scene.videoCount}/${scene.shotCount}</span>`;
  } else {
    const label = scene.id === project.startSceneId ? "起点" : isEnding ? "结局" : `${scene.choices.length || 1} 条走向`;
    html = `<small>${label}</small><strong>${escapeHtml(scene.title)}</strong><span class="node-assets${assetStatusClass}"><span class="asset-icon img">${imgDot}</span>图 <span class="asset-icon vid">${vidDot}</span>视频</span>`;
  }
  if (body._html !== html) { body._html = html; body.innerHTML = html; }
}

// 选择态快速通道：点选时只切换 .selected class，不重建任何节点或连线。
function updateTreeSelection() {
  const ctx = treeRenderContext;
  if (!ctx) { renderTreeBrowser(); return; }
  const isGrouped = Boolean(ctx.layout.grouped);
  const selectedId = project.selectedSceneId;
  treeNodeEls.forEach((node) => {
    const key = node.dataset.sceneId;            // 普通模式=场景 id；分组模式=group id（story:<key>）
    let isSelected;
    if (isGrouped) {
      const groupNode = ctx.byId.get(key);
      isSelected = groupNode ? groupNode.sceneIds.includes(selectedId) : key === selectedId;
    } else {
      isSelected = key === selectedId;
    }
    if (node._selected !== isSelected) {
      node._selected = isSelected;
      node.classList.toggle("selected", isSelected);
    }
  });
}

// 仅根据 treeRenderContext.positions 重画连线（拖动时高频调用，不重建节点）
function drawTreeEdges() {
  const ctx = treeRenderContext;
  if (!ctx) return;
  const { layout, positions, byId, nodeWidth, nodeHeight } = ctx;
  const paths = [];
  (layout.nodes || project.scenes).forEach((scene) => {
    const source = positions.get(scene.id);
    if (!source) return;
    storyTargets(scene).forEach((target) => {
      const destination = positions.get(target.id);
      if (!destination || !byId.has(target.id)) return;
      const x1 = source.x + nodeWidth, y1 = source.y + nodeHeight / 2;
      const x2 = destination.x, y2 = destination.y + nodeHeight / 2;
      const middle = (x1 + x2) / 2;
      const isSerial = currentMode === "serial";
      paths.push(`<path class="${isSerial ? "serial-edge" : ""}" d="M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}"></path>`);
    });
  });
  elements.treeEdges.innerHTML = paths.join("");
}

export function setTreeZoom(value) {
  setTreeZoomValue(Math.max(.35, Math.min(2.0, value)));
  applyTreeTransform();
  $("#treeZoomResetBtn").textContent = `${Math.round(treeZoom * 100)}%`;
}

// ─────────────────────────────────────────────
//  剧情树节点自由拖动（Pointer Events 实现）
//
//  说明：原实现用 HTML5 原生拖放（draggable + dragstart/drop）。但剧情树画布
//  施加了缩放且位于绝对定位视口中，Chromium/Electron 下原生拖放在缩放场景里坐标错乱，
//  导致“拖不动”。改用 Pointer Events，并把位移按当前 zoom 还原到画布坐标系，
//  让节点可以被自由拖到任意位置；坐标保存在 project.meta.treeLayout[mode][sceneId]，
//  连线在拖动中实时跟随。
// ─────────────────────────────────────────────

// 读取/写入当前模式下的自定义布局
function treeLayoutMap() {
  const all = project?.meta?.treeLayout;
  if (!all || typeof all !== "object") return {};
  const key = currentMode === "serial" ? "serial" : "interactive";
  return (all[key] && typeof all[key] === "object") ? all[key] : {};
}
function saveTreeNodePosition(sceneId, x, y) {
  if (!project.meta.treeLayout || typeof project.meta.treeLayout !== "object") project.meta.treeLayout = {};
  const key = currentMode === "serial" ? "serial" : "interactive";
  if (!project.meta.treeLayout[key]) project.meta.treeLayout[key] = {};
  project.meta.treeLayout[key][sceneId] = { x: Math.round(x), y: Math.round(y) };
  saveProject();
}

function bindTreeNodePointerDrag(node, sceneId, dims) {
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const pos = treeRenderContext?.positions?.get(sceneId) || { x: parseFloat(node.style.left) || 0, y: parseFloat(node.style.top) || 0 };
    treeDragState = {
      sceneId,
      node,
      dims,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: pos.x,
      originTop: pos.y,
      moved: false,
      pointerId: event.pointerId,
    };
  });
}

function onTreePointerMove(event) {
  if (!treeDragState) return;
  const dx = event.clientX - treeDragState.startX;
  const dy = event.clientY - treeDragState.startY;
  if (!treeDragState.moved && Math.hypot(dx, dy) < 5) return; // 阈值内视为点击
  if (!treeDragState.moved) {
    treeDragState.moved = true;
    treeDragState.node.classList.add("dragging");
    treeDragState.node.setPointerCapture?.(treeDragState.pointerId);
    document.body.classList.add("tree-dragging");
  }
  // 屏幕位移按 zoom 还原到画布坐标
  const zoom = treeZoom || 1;
  let nx = treeDragState.originLeft + dx / zoom;
  let ny = treeDragState.originTop + dy / zoom;
  nx = Math.max(0, nx);
  ny = Math.max(0, ny);
  treeDragState.node.style.left = `${nx}px`;
  treeDragState.node.style.top = `${ny}px`;
  treeDragState.lastX = nx;
  treeDragState.lastY = ny;
  // 实时更新 positions 并重画连线
  if (treeRenderContext?.positions) {
    treeRenderContext.positions.set(treeDragState.sceneId, { x: nx, y: ny });
    drawTreeEdges();
  }
}

function onTreePointerUp() {
  if (!treeDragState) return;
  const state = treeDragState;
  treeDragState = null;
  document.body.classList.remove("tree-dragging");
  state.node.classList.remove("dragging");
  if (!state.moved) return; // 没移动 → 交给 click 处理
  treeJustDragged = true;
  setTimeout(() => { treeJustDragged = false; }, 0);
  const x = state.lastX ?? state.originLeft;
  const y = state.lastY ?? state.originTop;
  saveTreeNodePosition(state.sceneId, x, y);
  // 扩展画布尺寸以容纳新位置
  const ctx = treeRenderContext;
  if (ctx) {
    const needW = x + state.dims.nodeWidth + 50;
    const needH = y + state.dims.nodeHeight + 50;
    if (needW > ctx.canvasWidth) { ctx.canvasWidth = needW; elements.treeCanvas.style.width = `${needW}px`; elements.treeEdges.setAttribute("width", needW); elements.treeEdges.setAttribute("viewBox", `0 0 ${needW} ${ctx.canvasHeight}`); }
    if (needH > ctx.canvasHeight) { ctx.canvasHeight = needH; elements.treeCanvas.style.height = `${needH}px`; elements.treeEdges.setAttribute("height", needH); elements.treeEdges.setAttribute("viewBox", `0 0 ${ctx.canvasWidth} ${needH}`); }
  }
}

export function setupTreeNodeDrag() {
  if (elements.treeNodes._pointerDragBound) return;
  elements.treeNodes._pointerDragBound = true;
  window.addEventListener("pointermove", onTreePointerMove);
  window.addEventListener("pointerup", onTreePointerUp);
  window.addEventListener("pointercancel", () => {
    if (treeDragState) treeDragState.node.classList.remove("dragging");
    treeDragState = null;
    document.body.classList.remove("tree-dragging");
  });
}

// 重置当前模式的自定义布局，回到自动排布
export function resetTreeLayout() {
  const key = currentMode === "serial" ? "serial" : "interactive";
  if (project.meta?.treeLayout?.[key]) {
    delete project.meta.treeLayout[key];
    saveProject();
    renderTreeBrowser();
    showToast("已恢复自动布局。");
  } else {
    showToast("当前已是自动布局。");
  }
}

export function toggleTreeFullscreen() { return _toggleTreeFullscreen(); }

async function _toggleTreeFullscreen() {
  try {
    if (document.fullscreenElement === elements.treeBrowser) await document.exitFullscreen();
    else await elements.treeBrowser.requestFullscreen();
  } catch (error) { showToast(`无法切换剧情树全屏：${error.message}`, true); }
}
