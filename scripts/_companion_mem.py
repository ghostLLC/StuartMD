# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\js\ui\companion.js")
t = p.read_text(encoding="utf-8")

# 1) richer empty states in initial DOM
t = t.replace(
    '<div class="sc-list" id="sc-messages"></div>',
    '<div class="sc-list" id="sc-messages"><div class="sc-empty sc-guide"><strong>问答</strong>：选中正文后点「引用选区」，或直接提问；<kbd>Alt+E</kbd> 可快速问答。</div></div>',
    1,
)
t = t.replace(
    '<div class="sc-empty">输入关键词检索当前文件夹的 Markdown。</div>',
    '<div class="sc-empty sc-guide"><strong>知识</strong>：在当前工作区 Markdown 中全文检索；点卡片可复制路径。不含向量索引，关键词即可。</div>',
    1,
)
t = t.replace(
    '<div class="sc-empty">记忆会在问答与「记入记忆」后逐渐丰富。</div>',
    '<div class="sc-empty sc-guide"><strong>记忆</strong>：问答后「记入记忆」会写在这里；点卡片可查看与删除。</div>',
    1,
)

# 2) clickable memory cards with content view
old = """      list.innerHTML = rows
        .map(
          (k) => `<div class="sc-card">
          <div class="sc-card-title">${esc(k.key)}</div>
          <div class="sc-card-meta">${esc(String(k.size || 0))} bytes</div>
        </div>`
        )
        .join("");"""
new = """      list.innerHTML = rows
        .map(
          (k) => `<div class="sc-card sc-card-click" data-mem-key="${esc(k.key)}" role="button" tabindex="0" title="点击查看内容">
          <div class="sc-card-title">${esc(k.key)}</div>
          <div class="sc-card-meta">${esc(String(k.size || 0))} bytes · 点击查看</div>
        </div>`
        )
        .join("");
      list.querySelectorAll("[data-mem-key]").forEach((el) => {
        el.addEventListener("click", () => showMemoryDetail(el.dataset.memKey));
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            showMemoryDetail(el.dataset.memKey);
          }
        });
      });"""
if old not in t:
    raise SystemExit("memory map block not found")
t = t.replace(old, new, 1)

# 3) add showMemoryDetail + improve vault card click copy
detail_fn = """
  async function showMemoryDetail(key) {
    const list = $("#sc-memory-list");
    const api = global.pywebview?.api;
    if (!api?.memory_get || !key) return;
    try {
      const res = await api.memory_get(key);
      const body = (res && res.content) || "";
      const err = res && res.error;
      list.innerHTML = `
        <div class="sc-detail">
          <div class="sc-detail-head">
            <button type="button" class="btn sm" id="sc-mem-back">返回列表</button>
            <button type="button" class="btn sm" id="sc-mem-del">删除</button>
          </div>
          <div class="sc-card-title">${esc(key)}</div>
          <pre class="sc-detail-body">${esc(err || body || "（空）")}</pre>
        </div>`;
      $("#sc-mem-back")?.addEventListener("click", () => loadMemory());
      $("#sc-mem-del")?.addEventListener("click", async () => {
        if (api.memory_delete) {
          await api.memory_delete(key);
          toast("已删除记忆：" + key);
        }
        loadMemory();
      });
    } catch (e) {
      list.innerHTML = `<div class="sc-empty">${esc(e && e.message ? e.message : e)}</div>`;
    }
  }
"""
anchor = "  global.StuartCompanion = {"
if "showMemoryDetail" not in t:
    t = t.replace(anchor, detail_fn + "\n" + anchor, 1)

# 4) vault cards: copy path on click
t = t.replace(
    """      list.innerHTML = hits
        .map(
          (h) => `<div class="sc-card">
          <div class="sc-card-title">${esc(h.name || h.path)}</div>
          <div class="sc-card-meta">L${esc(String(h.line || ""))}</div>
          <div class="sc-card-snippet">${esc(h.preview || "")}</div>
        </div>`
        )
        .join("");""",
    """      list.innerHTML = hits
        .map(
          (h) => `<div class="sc-card sc-card-click" data-path="${esc(h.path || "")}" title="点击复制路径">
          <div class="sc-card-title">${esc(h.name || h.path)}</div>
          <div class="sc-card-meta">L${esc(String(h.line || ""))} · 点击复制路径</div>
          <div class="sc-card-snippet">${esc(h.preview || "")}</div>
        </div>`
        )
        .join("");
      list.querySelectorAll("[data-path]").forEach((el) => {
        el.addEventListener("click", () => {
          const path = el.dataset.path;
          try {
            navigator.clipboard?.writeText(path);
            toast("已复制路径");
          } catch (_) {}
        });
      });""",
    1,
)

p.write_text(t, encoding="utf-8")
print("companion.js patched", p.stat().st_size)
