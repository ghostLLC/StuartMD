# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
p = ROOT / "web" / "js" / "ui" / "ai-ui.js"
t = p.read_text(encoding="utf-8")
start = t.find("  async function triggerExplain(")
end = t.find("  function handleShortcutKeydown")
if start < 0 or end < 0:
    raise SystemExit("markers not found start=%s end=%s" % (start, end))
new = """  async function triggerExplain(opts) {
    try {
      const o = opts || {};
      const now = Date.now();
      if (now - (uiState._lastTriggerAt || 0) < 350) return;
      uiState._lastTriggerAt = now;
      const AI = global.StuartAI;
      const C = global.StuartAIContext;
      if (!AI || !C) {
        toast("AI 模块未加载（StuartAI/StuartAIContext）");
        return;
      }
      try { global.StuartMD?.captureSelectionCache?.(); } catch (_) {}
      const quote = resolveSelectedQuote();
      if (!quote) {
        toast("请先选中要讲解的内容");
        return;
      }
      openPanel({ reposition: o.reposition !== false && !uiState.userMoved });
      const cfg = await AI.ensureConfig();
      const provider = currentProvider(cfg);
      if (cfg && cfg.enabled === false) {
        toast("AI 已关闭，请在右上角「模型」中启用");
        return;
      }
      const p = panelEls();
      if (p.quote) {
        p.quote.hidden = false;
        p.quote.textContent = quote.slice(0, 120);
      }
      if (p.meta) {
        p.meta.textContent = `${(provider && provider.label) || ""} · ${(cfg && cfg.thinking) || "balanced"} · ${getShortcut()}`;
      }
      resetChatForExplain(quote);
      pushChat("ai", "", { streaming: true });
      setThinking(true, "正在思考…");
      const badge = $("#ai-panel-badge");
      if (badge) { badge.textContent = "讲解中"; badge.dataset.state = "busy"; }
      uiState.lastQuote = quote;
      uiState.lastAnswer = "";
      uiState.lastMessages = [];
      uiState.isFirstAnswer = true;
      setFeedbackVisible(false);
      const res = await AI.explain(
        { kind: "markdown", quote },
        {
          onDelta: (full) => {
            setThinking(false);
            uiState.lastAnswer = full;
            updateStreamingChat(full);
          },
          onDone: async (payload) => {
            const text = payload && payload.text != null ? payload.text : uiState.lastAnswer;
            uiState.lastAnswer = text || "";
            const err = payload && payload.error && !text ? payload.error : null;
            finishStreamingChat(uiState.lastAnswer, err);
            const badge2 = $("#ai-panel-badge");
            if (badge2) {
              badge2.textContent = err ? "失败" : "完成";
              badge2.dataset.state = err ? "err" : "ok";
            }
            if (err) {
              const info = classifyAiError(err);
              toast(info.title);
              if (info.action === "open_settings") openSettingsFocus();
              return;
            }
            const built = C.buildMarkdownExplain(global.StuartMD, {
              quote,
              scope: (cfg && cfg.context_scope) || "neighborhood",
              maxChars: (cfg && cfg.context_max_chars) || 8000,
            });
            uiState.lastMeta = built.meta;
            const styleNow = AI.getStyle ? AI.getStyle() : {};
            uiState.lastMessages = [
              { role: "system", content: C.systemPrompt(styleNow) },
              { role: "user", content: built.promptUser },
              { role: "assistant", content: uiState.lastAnswer },
            ];
            try {
              const mm = await AI.handleMemoryAfterExplain(built.meta, quote, uiState.lastAnswer);
              if (mm && mm.ask) pushChat("system", "讲解完成。可点「记入记忆」保存偏好（记忆策略：询问）。");
              else if (mm && mm.ok && mm.mode === "always") pushChat("system", "已按「默认学习」记录本次活动。");
            } catch (_) {}
            if (uiState.isFirstAnswer) {
              setFeedbackVisible(true);
              uiState.isFirstAnswer = false;
            }
          },
        }
      );
      if (res && res.error) {
        setThinking(false);
        finishStreamingChat("", res.error);
        const badge3 = $("#ai-panel-badge");
        if (badge3) { badge3.textContent = "失败"; badge3.dataset.state = "err"; }
      } else if (res && res.meta && p.meta) {
        uiState.lastMeta = res.meta;
        p.meta.textContent = `${(provider && provider.label) || ""} · ${res.meta.heading || ""} · ${getShortcut()}`;
      }
    } catch (err) {
      console.error("triggerExplain failed", err);
      setThinking(false);
      finishStreamingChat("", err && err.message ? err.message : String(err));
      openPanel();
    }
  }

"""
p.write_text(t[:start] + new + t[end:], encoding="utf-8")
print("ok", start, end)
