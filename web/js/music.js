/* StuartMD music / ambient player */
(function () {
  "use strict";

  const PRESETS = [
    { id: "rain", name: "细雨", url: "audio/rain.wav" },
    { id: "fire", name: "壁炉", url: "audio/fire.wav" },
    { id: "library", name: "静室", url: "audio/library.wav" },
  ];

  const state = {
    playing: false,
    volume: 0.4,
    currentId: "rain",
    customUrl: null,
    customName: "",
  };

  const audio = new Audio();
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = state.volume;

  function $(id) {
    return document.getElementById(id);
  }

  function currentSrc() {
    if (state.currentId === "custom" && state.customUrl) return state.customUrl;
    const p = PRESETS.find((x) => x.id === state.currentId) || PRESETS[0];
    return p.url;
  }

  function renderList() {
    const box = $("music-list");
    if (!box) return;
    box.innerHTML = "";
    PRESETS.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "music-item" + (state.currentId === p.id ? " active" : "");
      b.textContent = p.name;
      b.addEventListener("click", () => selectTrack(p.id));
      box.appendChild(b);
    });
    if (state.customName) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "music-item" + (state.currentId === "custom" ? " active" : "");
      b.textContent = state.customName;
      b.addEventListener("click", () => selectTrack("custom"));
      box.appendChild(b);
    }
  }

  const SVG_PLAY =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5L8 5.5z"/></svg>';
  const SVG_PAUSE =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3v14H7V5zm7 0h3v14h-3V5z"/></svg>';

  function updateToggle() {
    const btn = $("music-toggle");
    if (btn) {
      // playing → pause icon; paused → play icon
      btn.innerHTML = state.playing ? SVG_PAUSE : SVG_PLAY;
      btn.title = state.playing ? "暂停" : "播放";
      btn.setAttribute("aria-label", state.playing ? "暂停" : "播放");
    }
    const musicBtn = $("btn-music");
    if (musicBtn) {
      musicBtn.classList.toggle("active", state.playing);
      musicBtn.title = state.playing ? "暂停音乐" : "白噪音 / 音乐";
    }
  }

  function selectTrack(id) {
    state.currentId = id;
    const src = currentSrc();
    const was = state.playing;
    audio.src = src;
    audio.load();
    if (was) {
      audio.play().catch(() => {});
    }
    renderList();
    persist();
  }

  async function toggle() {
    if (state.playing) {
      audio.pause();
      state.playing = false;
      updateToggle();
      persist();
      return;
    }
    if (!audio.src) audio.src = currentSrc();
    try {
      await audio.play();
      state.playing = true;
    } catch (_) {
      state.playing = false;
    }
    updateToggle();
    persist();
  }

  function persist() {
    if (!window.pywebview?.api?.save_settings) return;
    window.pywebview.api
      .save_settings({
        music: {
          volume: state.volume,
          currentId: state.currentId,
          customName: state.customName || "",
          playing: false, // do not autoplay across restarts unless desired
        },
      })
      .catch(() => {});
  }

  function restore(s) {
    if (!s) return;
    state.volume = typeof s.volume === "number" ? s.volume : 0.4;
    if (s.currentId) state.currentId = s.currentId;
    if (s.customName) state.customName = s.customName;
    audio.volume = state.volume;
    const vol = $("music-vol");
    if (vol) vol.value = String(Math.round(state.volume * 100));
    renderList();
  }

  function bind() {
    const trigger = $("btn-music");
    const panel = $("music-panel");
    if (trigger && panel) {
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = panel.hidden;
        document.querySelectorAll(".file-menu").forEach((m) => {
          if (m !== panel) m.hidden = true;
        });
        panel.hidden = !open;
      });
      document.addEventListener("click", (e) => {
        if (!e.target.closest("#btn-music") && !e.target.closest("#music-panel")) {
          panel.hidden = true;
        }
      });
    }
    $("music-toggle")?.addEventListener("click", toggle);
    $("music-vol")?.addEventListener("input", (e) => {
      state.volume = Number(e.target.value) / 100;
      audio.volume = state.volume;
      persist();
    });
    $("music-open-file")?.addEventListener("click", () => $("music-file-input")?.click());
    $("music-file-input")?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (state.customUrl) URL.revokeObjectURL(state.customUrl);
      state.customUrl = URL.createObjectURL(f);
      state.customName = f.name;
      selectTrack("custom");
      if (!state.playing) toggle();
      e.target.value = "";
    });
    audio.addEventListener("ended", () => {
      state.playing = false;
      updateToggle();
    });
    renderList();
    updateToggle();
  }

  document.addEventListener("DOMContentLoaded", bind);

  window.StuartMusic = { restore, toggle, PRESETS };
})();
