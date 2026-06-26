// Narrative Forge 前端入口（打包后输出 static/dist/bundle.js）。
// 负责装配：导入 episode-model（注册全局）→ 初始化 DOM 缓存 → 创建初始 project →
// 绑定事件 → 首次渲染 → 暴露 window.FrameForgeApp → 健康检查 → 装配导出按钮。
import "./episode-model.js"; // 注册 window.FrameForgeEpisodeModel
import { setProject, project, currentMode } from "./state.js";
import { initElements } from "./state.js";
import {
  normalizeProject, loadProject, readMetaFromForm, applyMetaToForm,
  saveProject, updateRecoveryButton,
} from "./project-model.js";
import { render, syncEditorToScene } from "./render.js";
import { bindEvents } from "./events.js";
import { checkHealth } from "./project-io.js";
import { validateStoryGraph } from "./story-graph.js";
import { requestJson } from "./api.js";
import { showToast } from "./utils.js";
import { initAgentPanel } from "./agent-panel.js";
import { loadProviderConfig, saveProviderConfig } from "./provider-config.js";

function bootstrap() {
  initElements();

  // 初始项目（原实现在脚本顶层即创建；打包后入口已在 DOM 就绪后执行）
  setProject(normalizeProject(loadProject() || {
    version: 6,
    meta: readMetaFromForm(),
    interactive: { scenes: [], selectedSceneId: null, startSceneId: null },
    episodes: [],
    selectedEpisodeId: null,
  }));

  // 对外门面（供 publish 等使用）
  window.FrameForgeApp = {
    getProject: () => project,
    syncProject() { syncEditorToScene(); saveProject(); },
    validateStory: validateStoryGraph,
    requestJson,
    showToast,
  };

  applyMetaToForm();
  bindEvents();
  render();
  document.body.dataset.appReady = "true";
  checkHealth();
  updateRecoveryButton();

  // 异步加载供应商配置（填充 BaseURL / Model / ApiKey 表单字段）
  loadProviderConfig();

  // 「保存供应商设置」按钮
  const saveProviderBtn = document.querySelector("#saveProviderConfigBtn");
  if (saveProviderBtn) {
    saveProviderBtn.addEventListener("click", saveProviderConfig);
  }

  bindPublishButton();
  initAgentPanel();
}

// 原 publish-feature.js 的逻辑，直接内联装配。
// 导出已改为后台任务：提交→轮询进度→完成下载；进行中可再次点击取消。
function bindPublishButton() {
  const app = window.FrameForgeApp;
  const button = document.querySelector("#exportPlayerBtn");
  if (!button) return;

  let activeJobId = null;
  let polling = false;
  let cancelling = false;

  const idleLabel = () => (app.getProject()?.meta?.mode === "serial" ? "导出当前集成片" : "导出试玩包");

  const resetButton = () => {
    activeJobId = null; polling = false; cancelling = false;
    button.disabled = false;
    button.classList.remove("exporting");
    button.textContent = idleLabel();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pollJob(jobId, isSerial) {
    polling = true;
    while (polling) {
      let snap;
      try {
        snap = await app.requestJson(`/api/jobs/${encodeURIComponent(jobId)}`);
      } catch (error) {
        app.showToast(`无法查询导出进度：${error.message}`, true);
        resetButton();
        return;
      }
      if (cancelling) button.textContent = "正在取消…";
      else if (snap.status === "running" || snap.status === "queued") {
        const pct = Math.max(0, Math.min(100, snap.progress || 0));
        button.textContent = `${snap.message || "处理中"} ${pct}%（点击取消）`;
      }
      if (snap.status === "completed") {
        const result = snap.result || {};
        const link = document.createElement("a");
        link.href = result.downloadUrl; link.download = "";
        document.body.appendChild(link); link.click(); link.remove();
        if (isSerial) {
          app.showToast(`“${result.episodeTitle || "当前集"}”成片已生成：${result.sceneCount} 个镜头。`);
        } else {
          const warning = result.warnings?.length ? `，${result.warnings.length} 项素材警告` : "";
          app.showToast(`试玩包已生成：${result.sceneCount} 个节点、${result.assetCount} 个素材${warning}。`);
        }
        resetButton();
        return;
      }
      if (snap.status === "failed") {
        app.showToast(`${isSerial ? "当前集成片" : "试玩包"}导出失败：${snap.error || "未知错误"}`, true);
        resetButton();
        return;
      }
      if (snap.status === "cancelled") {
        app.showToast("已取消导出。");
        resetButton();
        return;
      }
      await sleep(700);
    }
  }

  button.addEventListener("click", async () => {
    // 进行中再次点击 = 取消
    if (activeJobId) {
      if (cancelling) return;
      cancelling = true;
      button.textContent = "正在取消…";
      try { await app.requestJson("/api/cancel-job", { method: "POST", body: JSON.stringify({ jobId: activeJobId }) }); }
      catch (error) { app.showToast(`取消失败：${error.message}`, true); cancelling = false; }
      return;
    }

    app.syncProject();
    const proj = app.getProject();
    const isSerial = proj.meta?.mode === "serial";
    if (isSerial) {
      const episode = proj.episodes?.find((item) => item.id === proj.selectedEpisodeId);
      if (!episode) return app.showToast("当前没有选中的分集。", true);
      if (!episode.scenes?.length) return app.showToast(`“${episode.meta?.title || "当前集"}”没有镜头，无法导出。`, true);
    } else {
      const issues = app.validateStory(false);
      if (issues.length) { app.showToast(`试玩包未导出：${issues.slice(0, 2).join("；")}`, true); return; }
    }

    button.classList.add("exporting");
    button.textContent = "正在提交…";
    try {
      const accepted = await app.requestJson(isSerial ? "/api/export-serial" : "/api/export-player", {
        method: "POST",
        body: JSON.stringify({ project: proj, episode_id: isSerial ? proj.selectedEpisodeId : undefined }),
      });
      activeJobId = accepted.jobId;
      button.textContent = "处理中 0%（点击取消）";
      pollJob(activeJobId, isSerial);
    } catch (error) {
      app.showToast(`${isSerial ? "当前集成片" : "试玩包"}导出失败：${error.message}`, true);
      resetButton();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
