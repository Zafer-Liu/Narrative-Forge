(() => {
  "use strict";
  window.FrameForgeFeatures.register({
    id: "player-package-export",
    order: 30,
    init(app) {
      const button = document.querySelector("#exportPlayerBtn");
      if (!button) return;
      button.addEventListener("click", async () => {
        app.syncProject();
        const project = app.getProject();
        const isSerial = project.meta?.mode === "serial";
        if (isSerial) {
          const episode = project.episodes?.find((item) => item.id === project.selectedEpisodeId);
          if (!episode) return app.showToast("当前没有选中的分集。", true);
          if (!episode.scenes?.length) return app.showToast(`“${episode.meta?.title || "当前集"}”没有镜头，无法导出。`, true);
        } else {
          const issues = app.validateStory(false);
          if (issues.length) {
            app.showToast(`试玩包未导出：${issues.slice(0, 2).join("；")}`, true);
            return;
          }
        }
        button.disabled = true; button.textContent = isSerial ? "正在拼接当前集…" : "正在打包…";
        try {
          const result = await app.requestJson(isSerial ? "/api/export-serial" : "/api/export-player", {
            method: "POST",
            body: JSON.stringify({ project, episode_id: isSerial ? project.selectedEpisodeId : undefined }),
          });
          const link = document.createElement("a");
          link.href = result.downloadUrl;
          link.download = "";
          document.body.appendChild(link); link.click(); link.remove();
          if (isSerial) {
            app.showToast(`“${result.episodeTitle || "当前集"}”成片已生成：${result.sceneCount} 个镜头。`);
          } else {
            const warning = result.warnings?.length ? `，${result.warnings.length} 项素材警告` : "";
            app.showToast(`试玩包已生成：${result.sceneCount} 个节点、${result.assetCount} 个素材${warning}。`);
          }
        } catch (error) {
          app.showToast(`${isSerial ? "当前集成片" : "试玩包"}导出失败：${error.message}`, true);
        } finally {
          button.disabled = false; button.textContent = isSerial ? "导出当前集成片" : "导出试玩包";
        }
      });
    },
  });
})();
