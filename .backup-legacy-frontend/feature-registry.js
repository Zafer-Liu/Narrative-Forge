(() => {
  "use strict";
  const features = new Map();
  let started = false;

  window.FrameForgeFeatures = {
    register(feature) {
      if (!feature?.id || typeof feature.init !== "function") throw new Error("功能注册必须包含 id 和 init。 ");
      if (features.has(feature.id)) throw new Error(`功能已注册：${feature.id}`);
      features.set(feature.id, { order: 100, ...feature });
    },
    async start(context) {
      if (started) return;
      started = true;
      const ordered = [...features.values()].sort((left, right) => left.order - right.order);
      for (const feature of ordered) {
        try { await feature.init(context); }
        catch (error) { console.error(`功能初始化失败：${feature.id}`, error); }
      }
    },
    list() { return [...features.keys()]; },
  };

  document.addEventListener("DOMContentLoaded", () => {
    window.FrameForgeFeatures.start(window.FrameForgeApp || {});
  }, { once: true });
})();
