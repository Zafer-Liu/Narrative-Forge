(() => {
  "use strict";
  const project = window.FRAMEFORGE_PROJECT;
  const $ = (selector) => document.querySelector(selector);
  const byId = new Map((project?.scenes || []).map((scene) => [scene.id, scene]));
  const state = { sceneId: project?.startSceneId || project?.scenes?.[0]?.id || "", history: [] };

  function mediaPath(value) { return value ? encodeURI(value) : ""; }

  function render() {
    const scene = byId.get(state.sceneId);
    if (!scene) return;
    $("#progress").textContent = project.meta?.mode === "serial"
      ? `第${scene.episode || 1}集 · 第${scene.episodeOrder || state.history.length + 1}镜`
      : `经历 ${state.history.length + 1} 个剧情节点`;
    $("#sceneTitle").textContent = scene.title;
    $("#action").textContent = scene.action || "";
    $("#dialogue").textContent = scene.dialogue || "";
    $("#dialogue").hidden = !scene.dialogue;
    const stage = $("#stage");
    stage.innerHTML = "";
    const frame = document.createElement("div"); frame.className = "media-frame";
    if (scene.video) {
      const video = document.createElement("video");
      video.src = mediaPath(scene.video); video.controls = true; video.autoplay = true; video.playsInline = true;
      frame.appendChild(video);
    } else if (scene.image) {
      const image = document.createElement("img"); image.src = mediaPath(scene.image); image.alt = scene.title;
      frame.appendChild(image);
    } else {
      frame.innerHTML = `<div class="empty"><strong>${scene.title}</strong><span>该节点没有打包影音素材</span></div>`;
    }
    stage.appendChild(frame);

    const choices = $("#choices"); choices.innerHTML = "";
    const targets = scene.choices?.length ? scene.choices : (scene.nextSceneId ? [{ text: "继续", effect: "", targetSceneId: scene.nextSceneId }] : []);
    targets.forEach((choice) => {
      const button = document.createElement("button"); button.className = "choice";
      const strong = document.createElement("strong"); strong.textContent = choice.text || "继续"; button.appendChild(strong);
      if (choice.effect) { const small = document.createElement("small"); small.textContent = choice.effect; button.appendChild(small); }
      button.addEventListener("click", () => {
        if (!byId.has(choice.targetSceneId)) return;
        state.history.push({ sceneId: scene.id, choice: choice.text }); state.sceneId = choice.targetSceneId; render();
      });
      choices.appendChild(button);
    });
    if (!targets.length) {
      const ending = document.createElement("div"); ending.className = "ending"; ending.textContent = "结局已达成"; choices.appendChild(ending);
    }
  }

  function restart() { state.sceneId = project.startSceneId || project.scenes?.[0]?.id || ""; state.history = []; render(); }
  function start() { $("#landing").hidden = true; $("#game").hidden = false; restart(); }
  async function fullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen(); else await $("#app").requestFullscreen();
  }

  if (!project?.scenes?.length) { document.body.innerHTML = '<div class="fatal">试玩包没有剧情节点。</div>'; return; }
  document.title = project.meta?.title || "Narrative Forge 互动影游";
  $("#title").textContent = project.meta?.title || "互动影游";
  $("#genre").textContent = project.meta?.genre || "互动影游";
  $("#synopsis").textContent = project.meta?.synopsis || "选择将改变故事走向。";
  $("#app").dataset.aspect = project.meta?.aspectRatio || "16:9";
  $("#startBtn").addEventListener("click", start);
  $("#restartBtn").addEventListener("click", restart);
  $("#fullscreenBtn").addEventListener("click", () => fullscreen().catch(() => {}));
})();
