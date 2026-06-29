import { $, elements, currentMode, project } from "./state.js";
import { escapeHtml, showToast, spokenCharacterCount, dialogueBudget, choiceUid } from "./utils.js";
import {
  selectedScene, orderedScenes, activeEpisode, serialSceneEntries,
  findSceneAcrossProject, saveProject,
  normalizeCharacterCard, characterCardToText, normalizeSceneCard,
} from "./project-model.js";
import {
  inferEntryState, inferExitState, serialSceneNeighbors,
  composeImagePrompt, composeVideoPrompt, mergeVideoNarrativeContext,
} from "./prompt.js";
import { renderSceneList } from "./scene-list.js";
import { renderEpisodeList } from "./episodes.js";
import { updateSerialEstimate } from "./draft.js";
import {
  proxyMediaUrl, downloadMediaUrl, saveAsset, stopTask, resumeTask, requestJson,
  generateCharacterImage, stopCharacterImageTask,
  generateSceneCardImage, stopSceneCardImageTask,
} from "./api.js";
import { openMediaPreview } from "./player.js";

// ─────────────────────────────────────────────
//  独立图片放大预览（不依赖 player.js，避免循环依赖问题）
// ─────────────────────────────────────────────
function showImagePreview(src, title) {
  let overlay = document.getElementById("_imgZoomOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "_imgZoomOverlay";
    overlay.className = "img-zoom-overlay";
    overlay.addEventListener("click", () => { overlay.style.display = "none"; overlay.innerHTML = ""; });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = "";
  const img = document.createElement("img");
  img.src = src;
  img.alt = title || "图片预览";
  overlay.appendChild(img);
  const hint = document.createElement("span");
  hint.textContent = "点击任意处关闭";
  hint.className = "img-zoom-hint";
  overlay.appendChild(hint);
  overlay.style.display = "flex";
}

// ─────────────────────────────────────────────
//  角色卡面板（多角色结构化编辑）
//  渲染 project.meta.characters，支持增删改，实时同步兼容字段 meta.character
// ─────────────────────────────────────────────
export function renderCharacterPanel(target, openAll) {
  const overviewOpen = document.body.classList.contains("overview-open");
  if (!target) target = overviewOpen ? "#overviewCharacterPanel" : "#characterPanel";
  if (openAll === undefined) openAll = overviewOpen;
  const panel = $(target);
  if (!panel) return;
  const characters = Array.isArray(project.meta.characters) ? project.meta.characters : [];
  const fields = [
    ["name", "姓名", 60],
    ["ageRange", "年龄段", 40],
    ["gender", "性别呈现", 40],
    ["hair", "发型", 80],
    ["outfit", "服装", 200],
    ["props", "携带物品/特征", 200],
    ["emotion", "情绪基调", 80],
    ["performance", "表演风格", 80],
  ];
  panel.innerHTML = (characters.length > 1 ? `<div class="card-toggle-all" data-target="${target}">全部展开 / 收起</div>` : "") + characters.map((card, index) => `
    <details class="character-card" data-char-id="${escapeHtml(card.id)}"${openAll || index === 0 ? " open" : ""}>
      <summary>
        <strong>角色 ${index + 1}${card.name ? " · " + escapeHtml(card.name) : ""}</strong>
        <button type="button" class="text-button remove-char" data-char-id="${escapeHtml(card.id)}" title="删除该角色">删除</button>
      </summary>
      <div class="char-portrait">
        ${card.imageStatus === "working"
          ? `<div class="char-portrait-loading"><span class="spinner"></span>角色设定图生成中…</div>
             <button type="button" class="button ghost wide stop-char-img" data-char-id="${escapeHtml(card.id)}">停止</button>`
          : card.imageUrl
          ? `<div class="char-portrait-img-wrap">
               <img src="${proxyMediaUrl(card.imageUrl)}" alt="${escapeHtml(card.name)}设定图" />
               <button type="button" class="char-img-zoom" data-img-src="${escapeHtml(proxyMediaUrl(card.imageUrl))}" data-img-title="${escapeHtml(card.name + ' · 设定图')}" title="放大查看">⤢</button>
             </div>
             <button type="button" class="button ghost wide regen-char-img" data-char-id="${escapeHtml(card.id)}">重新生成</button>`
          : `<button type="button" class="button ghost wide gen-char-img" data-char-id="${escapeHtml(card.id)}">生成角色设定图</button>`
        }
      </div>
      <div class="char-grid">
        ${fields.map(([key, label, maxlen]) => `
          <label>${label}<input class="char-field" data-field="${key}" value="${escapeHtml(card[key] || "")}" maxlength="${maxlen}"></label>
        `).join("")}
      </div>
      <label>备注/补充<textarea class="char-field" data-field="notes" rows="2" maxlength="1000">${escapeHtml(card.notes || "")}</textarea></label>
    </details>
  `).join("") + `<button type="button" class="button ghost wide add-character-btn">＋ 添加角色</button>`;

  // 输入实时更新角色卡数据与兼容字段
  panel.querySelectorAll(".char-field").forEach((input) => {
    input.addEventListener("input", () => {
      const cardEl = input.closest(".character-card");
      const id = cardEl.dataset.charId;
      const card = project.meta.characters.find((c) => c.id === id);
      if (!card) return;
      card[input.dataset.field] = input.value;
      // 第一个角色卡同步到兼容字段 meta.character（供 draft/app.py 等旧逻辑读取）
      if (project.meta.characters[0] && id === project.meta.characters[0].id) {
        project.meta.character = characterCardToText(card);
        if (elements.projectCharacter) elements.projectCharacter.value = project.meta.character;
      }
      saveProject();
    });
  });
  // 删除角色
  panel.querySelectorAll(".remove-char").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.charId;
      project.meta.characters = project.meta.characters.filter((c) => c.id !== id);
      project.meta.character = project.meta.characters.length
        ? characterCardToText(project.meta.characters[0])
        : "";
      if (elements.projectCharacter) elements.projectCharacter.value = project.meta.character;
      renderCharacterPanel(target, openAll);
      saveProject();
    });
  });
  // 生成 / 重新生成角色设定图
  panel.querySelectorAll(".gen-char-img, .regen-char-img").forEach((btn) => {
    btn.addEventListener("click", () => generateCharacterImage(btn.dataset.charId));
  });
  // 停止角色图生成
  panel.querySelectorAll(".stop-char-img").forEach((btn) => {
    btn.addEventListener("click", () => stopCharacterImageTask(btn.dataset.charId));
  });
  // 点击放大按钮预览
  panel.querySelectorAll(".char-img-zoom").forEach((btn) => {
    btn.addEventListener("click", () => showImagePreview(btn.dataset.imgSrc, btn.dataset.imgTitle || "角色设定图"));
  });
  // 添加角色
  const addBtn = panel.querySelector(".add-character-btn");
  if (addBtn) addBtn.addEventListener("click", () => {
    project.meta.characters.push(normalizeCharacterCard({ name: "新角色" }));
    renderCharacterPanel(target, openAll);
    saveProject();
  });
  // 全部展开/收起
  const charToggle = panel.querySelector(".card-toggle-all");
  if (charToggle) charToggle.addEventListener("click", () => {
    const cards = panel.querySelectorAll(".character-card");
    const allOpen = Array.from(cards).every((c) => c.hasAttribute("open"));
    cards.forEach((c) => { if (allOpen) c.removeAttribute("open"); else c.setAttribute("open", ""); });
  });
}

// ─────────────────────────────────────────────
//  场景卡面板（多场景结构化编辑）
// ─────────────────────────────────────────────
export function renderSceneCardPanel(target, openAll) {
  const overviewOpen = document.body.classList.contains("overview-open");
  if (!target) target = overviewOpen ? "#overviewSceneCardPanel" : "#sceneCardPanel";
  if (openAll === undefined) openAll = overviewOpen;
  const panel = $(target);
  if (!panel) return;
  const cards = Array.isArray(project.meta.sceneCards) ? project.meta.sceneCards : [];
  const fields = [
    ["name", "场景名称", 60],
    ["type", "场景类型", 40],
    ["lighting", "光照", 200],
    ["colorTone", "色调", 80],
    ["atmosphere", "氛围", 200],
    ["environment", "环境细节", 500],
    ["timeOfDay", "时间/天气", 80],
  ];
  panel.innerHTML = (cards.length > 1 ? `<div class="card-toggle-all" data-target="${target}">全部展开 / 收起</div>` : "") + cards.map((card, index) => `
    <details class="character-card scene-card" data-scene-id="${escapeHtml(card.id)}"${openAll || index === 0 ? " open" : ""}>
      <summary>
        <strong>场景 ${index + 1}${card.name ? " · " + escapeHtml(card.name) : ""}</strong>
        <button type="button" class="text-button remove-char" data-scene-id="${escapeHtml(card.id)}" title="删除该场景">删除</button>
      </summary>
      <div class="char-portrait">
        ${card.imageStatus === "working"
          ? `<div class="char-portrait-loading"><span class="spinner"></span>场景参考图生成中…</div>
             <button type="button" class="button ghost wide stop-scene-img" data-scene-id="${escapeHtml(card.id)}">停止</button>`
          : card.imageUrl
          ? `<div class="char-portrait-img-wrap">
               <img src="${proxyMediaUrl(card.imageUrl)}" alt="${escapeHtml(card.name)}参考图" />
               <button type="button" class="char-img-zoom" data-img-src="${escapeHtml(proxyMediaUrl(card.imageUrl))}" data-img-title="${escapeHtml(card.name + ' · 参考图')}" title="放大查看">⤢</button>
             </div>
             <button type="button" class="button ghost wide regen-scene-img" data-scene-id="${escapeHtml(card.id)}">重新生成</button>`
          : `<button type="button" class="button ghost wide gen-scene-img" data-scene-id="${escapeHtml(card.id)}">生成场景参考图</button>`
        }
      </div>
      <div class="char-grid">
        ${fields.map(([key, label, maxlen]) => `
          <label>${label}<input class="scene-field" data-field="${key}" value="${escapeHtml(card[key] || "")}" maxlength="${maxlen}"></label>
        `).join("")}
      </div>
      <label>备注/补充<textarea class="scene-field" data-field="notes" rows="2" maxlength="1000">${escapeHtml(card.notes || "")}</textarea></label>
    </details>
  `).join("") + `<button type="button" class="button ghost wide add-scene-card-btn">＋ 添加场景</button>`;

  panel.querySelectorAll(".scene-field").forEach((input) => {
    input.addEventListener("input", () => {
      const cardEl = input.closest(".scene-card");
      const id = cardEl.dataset.sceneId;
      const card = project.meta.sceneCards.find((c) => c.id === id);
      if (!card) return;
      card[input.dataset.field] = input.value;
      saveProject();
    });
  });
  panel.querySelectorAll(".remove-char").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.sceneId;
      project.meta.sceneCards = project.meta.sceneCards.filter((c) => c.id !== id);
      renderSceneCardPanel(target, openAll);
      saveProject();
    });
  });
  panel.querySelectorAll(".gen-scene-img, .regen-scene-img").forEach((btn) => {
    btn.addEventListener("click", () => generateSceneCardImage(btn.dataset.sceneId));
  });
  panel.querySelectorAll(".stop-scene-img").forEach((btn) => {
    btn.addEventListener("click", () => stopSceneCardImageTask(btn.dataset.sceneId));
  });
  // 点击放大按钮预览
  panel.querySelectorAll(".char-img-zoom").forEach((btn) => {
    btn.addEventListener("click", () => showImagePreview(btn.dataset.imgSrc, btn.dataset.imgTitle || "场景参考图"));
  });
  const addBtn = panel.querySelector(".add-scene-card-btn");
  if (addBtn) addBtn.addEventListener("click", () => {
    project.meta.sceneCards.push(normalizeSceneCard({ name: "新场景" }));
    renderSceneCardPanel(target, openAll);
    saveProject();
  });
  // 全部展开/收起
  const sceneToggle = panel.querySelector(".card-toggle-all");
  if (sceneToggle) sceneToggle.addEventListener("click", () => {
    const cards = panel.querySelectorAll(".scene-card");
    const allOpen = Array.from(cards).every((c) => c.hasAttribute("open"));
    cards.forEach((c) => { if (allOpen) c.removeAttribute("open"); else c.setAttribute("open", ""); });
  });
}

// ─────────────────────────────────────────────
//  全屏项目概览编辑
// ─────────────────────────────────────────────
export function renderProjectOverview() {
  // 基础设定
  const basic = $("#overviewBasicSettings");
  if (basic) {
    const genreOpts = ["科幻悬疑", "奇幻冒险", "都市情感", "恐怖生存", "历史传奇"];
    const aspectOpts = [
      { value: "16:9", label: "16:9 横屏" },
      { value: "9:16", label: "9:16 竖屏" },
      { value: "1:1", label: "1:1 方形" },
    ];
    basic.innerHTML = `
      <div class="overview-basic-row">
        <label>片名<input id="ovTitle" value="${escapeHtml(project.meta.title || "")}" maxlength="80"></label>
        <label>类型<select id="ovGenre">${genreOpts.map((g) => `<option${g === project.meta.genre ? " selected" : ""}>${g}</option>`).join("")}</select></label>
        <label>画幅<select id="ovAspect">${aspectOpts.map((a) => `<option value="${a.value}"${a.value === project.meta.aspectRatio ? " selected" : ""}>${a.label}</option>`).join("")}</select></label>
      </div>
      <label>故事梗概<textarea id="ovSynopsis" rows="2">${escapeHtml(project.meta.synopsis || "")}</textarea></label>
      <label>视觉风格<textarea id="ovStyle" rows="1">${escapeHtml(project.meta.visualStyle || "")}</textarea></label>
    `;
    const syncText = (sel, key, sidebarEl) => {
      const input = $(sel);
      if (!input) return;
      input.addEventListener("input", () => {
        project.meta[key] = input.value;
        if (sidebarEl) sidebarEl.value = input.value;
        saveProject();
      });
    };
    syncText("#ovTitle", "title", elements.projectTitle);
    syncText("#ovSynopsis", "synopsis", elements.projectSynopsis);
    syncText("#ovStyle", "visualStyle", elements.projectStyle);
    const genreSelect = $("#ovGenre");
    if (genreSelect) genreSelect.addEventListener("change", () => {
      project.meta.genre = genreSelect.value;
      if (elements.projectGenre) elements.projectGenre.value = genreSelect.value;
      saveProject();
    });
    const aspectSelect = $("#ovAspect");
    if (aspectSelect) aspectSelect.addEventListener("change", () => {
      project.meta.aspectRatio = aspectSelect.value;
      if (elements.projectAspect) elements.projectAspect.value = aspectSelect.value;
      saveProject();
    });
  }

  // 角色卡
  renderCharacterPanel("#overviewCharacterPanel", true);

  // 场景卡
  renderSceneCardPanel("#overviewSceneCardPanel", true);

  // 剧本（分镜列表）
  const scriptList = $("#overviewSceneList");
  if (scriptList) {
    const scenes = orderedScenes();
    if (!scenes.length) {
      scriptList.innerHTML = `<p class="overview-empty">暂无分镜。请先在主界面生成剧情草案。</p>`;
    } else {
      const shotOpts = ["大全景", "全景", "中景", "近景", "特写"];
      const durationOpts = [4, 6, 8, 10, 12, 15];
      scriptList.innerHTML = scenes.map((scene, i) => `
        <div class="overview-scene-item" data-scene-id="${escapeHtml(scene.id)}">
          <div class="overview-scene-header">
            <span class="overview-scene-num">${i + 1}</span>
            <input class="overview-scene-title" value="${escapeHtml(scene.title || "")}" maxlength="80" placeholder="镜头标题">
            <select class="overview-scene-shot">${shotOpts.map((s) => `<option${s === scene.shot ? " selected" : ""}>${s}</option>`).join("")}</select>
            <select class="overview-scene-duration">${durationOpts.map((d) => `<option value="${d}"${d === scene.duration ? " selected" : ""}>${d}s</option>`).join("")}</select>
          </div>
          <textarea class="overview-scene-action" rows="2" maxlength="6000" placeholder="动作描述">${escapeHtml(scene.action || "")}</textarea>
          <textarea class="overview-scene-dialogue" rows="1" maxlength="3000" placeholder="对白">${escapeHtml(scene.dialogue || "")}</textarea>
        </div>
      `).join("");
      scriptList.querySelectorAll(".overview-scene-item").forEach((item) => {
        const sceneId = item.dataset.sceneId;
        const scene = scenes.find((s) => s.id === sceneId);
        if (!scene) return;
        item.querySelector(".overview-scene-title").addEventListener("input", (e) => {
          scene.title = e.target.value;
          saveProject();
        });
        item.querySelector(".overview-scene-shot").addEventListener("change", (e) => {
          scene.shot = e.target.value;
          saveProject();
        });
        item.querySelector(".overview-scene-duration").addEventListener("change", (e) => {
          scene.duration = Number(e.target.value);
          saveProject();
        });
        item.querySelector(".overview-scene-action").addEventListener("input", (e) => {
          scene.action = e.target.value;
          saveProject();
        });
        item.querySelector(".overview-scene-dialogue").addEventListener("input", (e) => {
          scene.dialogue = e.target.value;
          saveProject();
        });
      });
    }
  }
}

export function openProjectOverview() {
  const overlay = $("#projectOverview");
  if (!overlay) return;
  renderProjectOverview();
  overlay.hidden = false;
  document.body.classList.add("overview-open");
}

export function closeProjectOverview() {
  const overlay = $("#projectOverview");
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove("overview-open");
  renderCharacterPanel();
  renderSceneCardPanel();
  render();
}

// ─────────────────────────────────────────────
//  编辑器渲染
// ─────────────────────────────────────────────
function renderSceneCardSelector(scene) {
  const select = $("#sceneSceneCard");
  if (!select) return;
  const cards = Array.isArray(project.meta.sceneCards) ? project.meta.sceneCards : [];
  const options = ['<option value="">未指定场景卡</option>'];
  cards.forEach((card) => {
    const selected = card.id === scene.sceneCardId ? " selected" : "";
    const hasImage = Boolean(card.imageUrl);
    options.push(`<option value="${escapeHtml(card.id)}"${selected}>${escapeHtml(card.name)}${hasImage ? "（有参考图）" : ""}</option>`);
  });
  select.innerHTML = options.join("");
}

function renderCharacterSelector(scene) {
  const select = $("#sceneCharacters");
  if (!select) return;
  const characters = Array.isArray(project.meta.characters) ? project.meta.characters : [];
  const selectedIds = Array.isArray(scene.characterIds) ? scene.characterIds : [];
  select.innerHTML = characters.map((card) => {
    const selected = selectedIds.includes(card.id) ? " selected" : "";
    const hasImage = Boolean(card.imageUrl);
    return `<option value="${escapeHtml(card.id)}"${selected}>${escapeHtml(card.name)}${hasImage ? "（有设定图）" : ""}</option>`;
  }).join("");
}

export function renderEditor() {
  const scene = selectedScene();
  elements.sceneEditor.hidden = !scene;
  elements.emptyState.hidden = Boolean(scene);
  if (!scene) return;
  elements.sceneTitle.value = scene.title;
  elements.sceneShot.value = scene.shot;
  elements.sceneDuration.value = String(scene.duration);
  elements.sceneAction.value = scene.action;
  elements.sceneDialogue.value = scene.dialogue;
  renderSceneCardSelector(scene);
  renderCharacterSelector(scene);
  updateDialogueTiming(scene);
  if (currentMode === "interactive") {
    renderFlowEditor(scene);
  } else {
    renderSerialFlowEditor(scene);
  }
  renderReferenceSelector(scene);
  elements.sceneImagePrompt.value = scene.imagePrompt;
  elements.sceneVideoPrompt.value = scene.videoPrompt;
  renderMedia(scene);
  updateGenerationControls(scene);
}

export function renderSerialFlowEditor(scene) {
  const epSelect = $("#sceneEpisode");
  if (epSelect) {
    const episodeNumber = (activeEpisode()?.order || 0) + 1;
    epSelect.innerHTML = `<option value="${episodeNumber}">第${episodeNumber}集 · ${escapeHtml(activeEpisode()?.meta.title || "")}</option>`;
    epSelect.disabled = true;
  }
  const orderInput = $("#sceneEpisodeOrder");
  if (orderInput) orderInput.value = scene.episodeOrder || 1;
  if (elements.sceneTransition) {
    elements.sceneTransition.value = scene.transition || (scene.episodeOrder === 1 ? "cut" : "match");
    elements.sceneTransition.disabled = scene.episodeOrder === 1;
  }
  if (elements.sceneEntryState) elements.sceneEntryState.value = inferEntryState(scene, serialSceneNeighbors(scene).previous);
  if (elements.sceneExitState) elements.sceneExitState.value = inferExitState(scene, serialSceneNeighbors(scene).next);
}

export function updateGenerationControls(scene) {
  const imageButton = $("#generateImageBtn");
  const videoButton = $("#generateVideoBtn");
  imageButton.disabled = scene.imageStatus === "working";
  imageButton.textContent = scene.imageStatus === "working" ? "生成中…" : (scene.referenceSceneId ? "参考图生成关键帧" : "生成关键帧");
  videoButton.disabled = scene.videoStatus === "working";
  videoButton.textContent = scene.videoStatus === "working" ? "生成中…" : "由关键帧生成视频";
  $("#resetImageBtn").disabled = false;
  $("#resetVideoBtn").disabled = false;
}

export function renderReferenceSelector(scene) {
  const options = ['<option value="">独立文生图（不参考其他镜头）</option>'];
  if (currentMode === "serial") {
    let currentEpisode = 0;
    serialSceneEntries().forEach(({ scene: candidate, episode, episodeNumber, sceneNumber }) => {
      if (episodeNumber !== currentEpisode) {
        if (currentEpisode) options.push("</optgroup>");
        options.push(`<optgroup label="第${episodeNumber}集 · ${escapeHtml(episode.meta.title || "未命名")}">`);
        currentEpisode = episodeNumber;
      }
      if (candidate.id === scene.id) return;
      const available = Boolean(candidate.imageUrl || candidate.imageLocalUrl);
      const selected = candidate.id === scene.referenceSceneId ? " selected" : "";
      options.push(`<option value="${escapeHtml(candidate.id)}"${selected}${available ? "" : " disabled"}>${String(sceneNumber).padStart(2, "0")} · ${escapeHtml(candidate.title)}${available ? "" : "（尚无关键帧）"}</option>`);
    });
    if (currentEpisode) options.push("</optgroup>");
  } else {
    orderedScenes().forEach((candidate, index) => {
      if (candidate.id === scene.id) return;
      const available = Boolean(candidate.imageUrl || candidate.imageLocalUrl);
      const selected = candidate.id === scene.referenceSceneId ? " selected" : "";
      options.push(`<option value="${escapeHtml(candidate.id)}"${selected}${available ? "" : " disabled"}>${String(index + 1).padStart(2, "0")} · ${escapeHtml(candidate.title)}${available ? "" : "（尚无关键帧）"}</option>`);
    });
  }
  elements.sceneReference.innerHTML = options.join("");
  const reference = findSceneAcrossProject(scene.referenceSceneId);
  if (!scene.referenceSceneId) {
    elements.referenceStatus.innerHTML = '<strong>文生图模式</strong><span>适合首镜头或纯环境镜头</span>';
  } else if (reference?.imageUrl || reference?.imageLocalUrl) {
    elements.referenceStatus.innerHTML = `<strong>角色一致性模式</strong><span>使用"${escapeHtml(reference.title)}"的主角身份</span>`;
  } else {
    elements.referenceStatus.innerHTML = '<strong class="warning-text">参考图尚未生成</strong><span>请先生成所选母版镜头</span>';
  }
  const button = $("#generateImageBtn");
  if (!button.disabled) button.textContent = scene.referenceSceneId ? "参考图生成关键帧" : "生成关键帧";
}

export function sceneOptions(selectedId, excludeId = "") {
  const options = ['<option value="">— 无 / 剧情结束 —</option>'];
  orderedScenes().forEach((scene, index) => {
    if (scene.id === excludeId) return;
    const selected = scene.id === selectedId ? " selected" : "";
    options.push(`<option value="${escapeHtml(scene.id)}"${selected}>${String(index + 1).padStart(2, "0")} · ${escapeHtml(scene.title)}</option>`);
  });
  return options.join("");
}

export function renderFlowEditor(scene) {
  elements.sceneNext.innerHTML = sceneOptions(scene.nextSceneId, scene.id);
  elements.choiceList.innerHTML = "";
  if (!scene.choices.length) {
    elements.choiceList.innerHTML = '<div class="choice-empty">当前没有玩家选择，播放结束后将自动进入"下一镜头"。</div>';
    return;
  }
  scene.choices.forEach((choice, index) => {
    const row = document.createElement("div");
    row.className = "choice-row";
    row.innerHTML = `<span class="choice-number">${index + 1}</span>
      <label>按钮文案<input class="choice-text" maxlength="100"></label>
      <label>指向节点<select class="choice-target">${sceneOptions(choice.targetSceneId, scene.id)}</select></label>
      <label class="choice-effect-label">剧情影响<input class="choice-effect" maxlength="180" placeholder="例如：获得信任，进入救援路线"></label>
      <button class="choice-remove" title="删除选择">×</button>`;
    row.querySelector(".choice-text").value = choice.text;
    row.querySelector(".choice-effect").value = choice.effect;
    row.querySelector(".choice-text").addEventListener("change", (event) => { choice.text = event.target.value.trim() || "未命名选择"; saveProject(); renderSceneList(); });
    row.querySelector(".choice-target").addEventListener("change", (event) => { choice.targetSceneId = event.target.value; saveProject(); renderSceneList(); });
    row.querySelector(".choice-effect").addEventListener("change", (event) => { choice.effect = event.target.value.trim(); saveProject(); });
    row.querySelector(".choice-remove").addEventListener("click", () => { scene.choices = scene.choices.filter((item) => item.id !== choice.id); saveProject(); renderFlowEditor(scene); renderSceneList(); });
    elements.choiceList.appendChild(row);
  });
}

export function addChoice() {
  syncEditorToScene();
  const scene = selectedScene();
  if (!scene) return;
  scene.choices.push({ id: choiceUid(), text: `选择 ${scene.choices.length + 1}`, effect: "", targetSceneId: "" });
  saveProject(); renderFlowEditor(scene); renderSceneList();
}

export function updateDialogueTiming(scene = selectedScene()) {
  const hint = $("#dialogueTimingHint");
  if (!hint || !scene) return;
  const count = spokenCharacterCount(elements.sceneDialogue?.value ?? scene.dialogue);
  const duration = Number(elements.sceneDuration?.value || scene.duration || 8);
  const budget = dialogueBudget(duration);
  const overflow = count > budget;
  hint.textContent = overflow
    ? `当前约 ${count} 字，${duration} 秒建议不超过 ${budget} 字；可继续生成，但语速可能偏快。`
    : `当前约 ${count}/${budget} 字，按清晰语速约每秒 3 字估算。`;
  hint.classList.toggle("warning", overflow);
}

// ─────────────────────────────────────────────
//  媒体渲染（编辑器）
// ─────────────────────────────────────────────
export function renderMedia(scene) {
  if (scene.imageStatus === "working") elements.imageCard.innerHTML = `<div class="media-loading">图片供应商正在生成关键帧<small>任务 ${escapeHtml(scene.imagePredictionId || "正在提交")}</small><button class="button danger ghost media-stop" data-kind="image">停止等待</button></div>`;
  else if (scene.imageStatus === "paused" && scene.imagePredictionId) elements.imageCard.innerHTML = `<div class="media-paused"><strong>关键帧查询已暂停</strong><span>供应商任务可能仍在后台运行</span><button class="button primary media-resume" data-kind="image">继续查询结果</button></div>`;
  else if (scene.imageUrl || scene.imageLocalUrl) elements.imageCard.innerHTML = `<div class="media-content"><img alt="生成的镜头关键帧"><div class="media-actions"><span class="media-save-state"></span><a class="media-link media-open" target="_blank" rel="noopener">查看原图</a><a class="media-link media-download">下载图片</a><button class="button ghost media-save">保存到项目</button></div></div>`;
  else elements.imageCard.innerHTML = '<div class="media-placeholder">关键帧将在这里出现</div>';
  elements.imageCard.querySelector(".media-stop")?.addEventListener("click", () => stopTask(scene.id, "image"));
  elements.imageCard.querySelector(".media-resume")?.addEventListener("click", () => resumeTask(scene, "image"));
  if (scene.imageUrl || scene.imageLocalUrl) {
    const displayUrl = scene.imageLocalUrl || proxyMediaUrl(scene.imageUrl);
    elements.imageCard.querySelector("img").src = displayUrl;
    elements.imageCard.querySelector("img").addEventListener("error", () => showToast("图片预览加载失败，请保存到项目后重试。", true), { once: true });
    elements.imageCard.querySelector(".media-open").href = displayUrl;
    elements.imageCard.querySelector(".media-open").addEventListener("click", (event) => {
      event.preventDefault(); openMediaPreview("image", displayUrl, `${scene.title} · 关键帧`);
    });
    elements.imageCard.querySelector(".media-download").href = downloadMediaUrl(scene.imageUrl || scene.imageLocalUrl, `${scene.title}-关键帧`);
    elements.imageCard.querySelector(".media-download").download = "";
    const state = elements.imageCard.querySelector(".media-save-state");
    state.textContent = scene.imageLocalUrl ? "已保存" : "";
    state.className = `media-save-state${scene.imageLocalUrl ? " saved" : ""}`;
    const saveButton = elements.imageCard.querySelector(".media-save");
    saveButton.hidden = Boolean(scene.imageLocalUrl);
    saveButton.addEventListener("click", () => saveAsset(scene, "image", saveButton));
  }
  if (scene.videoStatus === "working") elements.videoCard.innerHTML = `<div class="media-loading">视频供应商正在生成视频<small>任务 ${escapeHtml(scene.videoPredictionId || "正在提交")}</small><button class="button danger ghost media-stop" data-kind="video">停止等待</button></div>`;
  else if (scene.videoStatus === "paused" && scene.videoPredictionId) elements.videoCard.innerHTML = `<div class="media-paused"><strong>视频查询已暂停</strong><span>供应商任务可能仍在后台运行</span><button class="button primary media-resume" data-kind="video">继续查询结果</button></div>`;
  else if (scene.videoUrl || scene.videoLocalUrl) elements.videoCard.innerHTML = `<div class="media-content"><video controls playsinline preload="metadata"></video><div class="media-actions"><span class="media-save-state"></span><a class="media-link media-open" target="_blank" rel="noopener">查看视频</a><a class="media-link media-download">下载视频</a><button class="button ghost media-save">保存到项目</button></div></div>`;
  else elements.videoCard.innerHTML = '<div class="media-placeholder">视频将在这里出现</div>';
  elements.videoCard.querySelector(".media-stop")?.addEventListener("click", () => stopTask(scene.id, "video"));
  elements.videoCard.querySelector(".media-resume")?.addEventListener("click", () => resumeTask(scene, "video"));
  if (scene.videoUrl || scene.videoLocalUrl) {
    const displayUrl = scene.videoLocalUrl || proxyMediaUrl(scene.videoUrl);
    elements.videoCard.querySelector("video").src = displayUrl;
    elements.videoCard.querySelector("video").addEventListener("error", () => showToast("视频预览加载失败，请点击保存到项目后重试。", true), { once: true });
    elements.videoCard.querySelector(".media-open").href = displayUrl;
    elements.videoCard.querySelector(".media-open").addEventListener("click", (event) => {
      event.preventDefault(); openMediaPreview("video", displayUrl, `${scene.title} · 视频`);
    });
    elements.videoCard.querySelector(".media-download").href = downloadMediaUrl(scene.videoUrl || scene.videoLocalUrl, `${scene.title}-视频`);
    elements.videoCard.querySelector(".media-download").download = "";
    const state = elements.videoCard.querySelector(".media-save-state");
    state.textContent = scene.videoLocalUrl ? "已保存" : "";
    state.className = `media-save-state${scene.videoLocalUrl ? " saved" : ""}`;
    const saveButton = elements.videoCard.querySelector(".media-save");
    saveButton.hidden = Boolean(scene.videoLocalUrl);
    saveButton.addEventListener("click", () => saveAsset(scene, "video", saveButton));
  }
  renderMediaPathEditor(scene, "image", elements.imageCard);
  renderMediaPathEditor(scene, "video", elements.videoCard);
}

export function renderMediaPathEditor(scene, kind, card) {
  const label = kind === "image" ? "图片路径" : "视频路径";
  const editor = document.createElement("div");
  editor.className = "media-path-editor";
  editor.innerHTML = `<label><span>${label}</span><input type="text" spellcheck="false" placeholder="projects 内的本地路径，或 https:// 素材地址"></label><button class="button ghost media-path-apply">应用</button>`;
  const input = editor.querySelector("input");
  input.value = scene[`${kind}Path`] || scene[`${kind}LocalUrl`] || scene[`${kind}Url`] || "";
  const apply = async () => {
    const value = input.value.trim();
    const button = editor.querySelector("button");
    if (!value) {
      scene[`${kind}Url`] = ""; scene[`${kind}LocalUrl`] = ""; scene[`${kind}Path`] = ""; scene[`${kind}Status`] = "idle";
      saveProject(); renderMedia(scene); return;
    }
    if (/^https:\/\//i.test(value)) {
      scene[`${kind}Url`] = value; scene[`${kind}LocalUrl`] = ""; scene[`${kind}Path`] = ""; scene[`${kind}Status`] = "completed";
      saveProject(); renderMedia(scene); showToast(`${label}已更新。`); return;
    }
    button.disabled = true; button.textContent = "检查中…";
    try {
      const result = await requestJson("/api/resolve-asset-path", { method: "POST", body: JSON.stringify({ path: value, kind }) });
      scene[`${kind}LocalUrl`] = result.localUrl; scene[`${kind}Path`] = result.path; scene[`${kind}Status`] = "completed";
      saveProject(); renderMedia(scene); showToast(`${label}已恢复：${result.path}`);
    } catch (error) { showToast(error.message, true); button.disabled = false; button.textContent = "应用"; }
  };
  editor.querySelector("button").addEventListener("click", apply);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } });
  card.appendChild(editor);
}

export function renderTaskResult(scene) {
  renderSceneList();
  if (project.selectedSceneId === scene.id) renderEditor();
}

// ─────────────────────────────────────────────
//  编辑器同步
// ─────────────────────────────────────────────
export function syncEditorToScene() {
  const scene = selectedScene();
  if (!scene || elements.sceneEditor.hidden) return;
  const nextValues = {
    title: elements.sceneTitle.value.trim() || "未命名镜头",
    shot: elements.sceneShot.value,
    duration: Number(elements.sceneDuration.value),
    action: elements.sceneAction.value.trim(),
    dialogue: elements.sceneDialogue.value.trim(),
    referenceSceneId: elements.sceneReference.value,
    sceneCardId: $("#sceneSceneCard")?.value || "",
    characterIds: Array.from($("#sceneCharacters")?.selectedOptions || []).map((opt) => opt.value),
    imagePrompt: elements.sceneImagePrompt.value.trim(),
  };
  if (currentMode === "interactive") {
    nextValues.nextSceneId = elements.sceneNext.value;
  } else {
    const orderInput = $("#sceneEpisodeOrder");
    nextValues.episode = (activeEpisode()?.order || 0) + 1;
    if (orderInput) nextValues.episodeOrder = Number(orderInput.value) || 1;
    if (elements.sceneTransition) nextValues.transition = elements.sceneTransition.value || "match";
    if (elements.sceneEntryState) nextValues.entryState = elements.sceneEntryState.value.trim();
    if (elements.sceneExitState) nextValues.exitState = elements.sceneExitState.value.trim();
  }
  nextValues.videoPrompt = mergeVideoNarrativeContext(elements.sceneVideoPrompt.value.trim(), nextValues);
  Object.assign(scene, nextValues);
  elements.sceneVideoPrompt.value = scene.videoPrompt;
  updateDialogueTiming(scene);
  saveProject(); renderSceneList();
}

export function render() {
  if (currentMode === "serial") renderEpisodeList();
  renderSceneList();
  renderEditor();
  if (currentMode === "serial") updateSerialEstimate();
}
