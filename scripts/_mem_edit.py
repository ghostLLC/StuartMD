# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\js\ui\companion.js")
t = p.read_text(encoding="utf-8")

# exclusive filter: profile vs notes
old_filter = """      const rows = keys.filter((k) => {
        if (filter === "all") return true;
        if (filter === "profile") return String(k.key || "").includes("profile") || String(k.key || "").includes("prefs");
        return true;
      });"""
new_filter = """      const isProfileKey = (key) => /(^|_)(profile|prefs|preference)/i.test(String(key || "")) || String(key || "") === "user_profile";
      const rows = keys.filter((k) => {
        const key = String(k.key || "");
        const profile = isProfileKey(key);
        if (filter === "all") return true;
        if (filter === "profile") return profile;
        if (filter === "notes") return !profile;
        return true;
      });"""
if old_filter not in t:
    raise SystemExit("filter block not found")
t = t.replace(old_filter, new_filter, 1)

# replace showMemoryDetail with editable version
start = t.find("  async function showMemoryDetail(key) {")
end = t.find("  global.StuartCompanion = {")
if start < 0 or end < 0 or end < start:
    raise SystemExit(f"bounds {start} {end}")
new_fn = r'''  async function showMemoryDetail(key) {
    const list = $("#sc-memory-list");
    const api = global.pywebview && global.pywebview.api;
    if (!list) return;
    if (!api || !api.memory_get) {
      list.innerHTML = `<div class="sc-empty">记忆接口不可用</div>`;
      return;
    }
    if (!key) {
      toast("无效的记忆键");
      return;
    }
    list.innerHTML = `<div class="sc-empty">加载中…</div>`;
    try {
      const res = await api.memory_get(key);
      const err = res && res.error;
      const body = (res && res.content) || "";
      list.innerHTML = `
        <div class="sc-detail">
          <div class="sc-detail-head">
            <button type="button" class="btn sm" id="sc-mem-back">返回</button>
            <button type="button" class="btn sm primary" id="sc-mem-save">保存</button>
            <button type="button" class="btn sm" id="sc-mem-del">删除</button>
          </div>
          <div class="sc-card-title">${esc(key)}</div>
          <textarea id="sc-mem-editor" class="sc-detail-edit" rows="12" spellcheck="false">${esc(err || body || "")}</textarea>
          <div class="sc-card-meta">单击内容可编辑，点「保存」写入</div>
        </div>`;
      const ta = document.getElementById("sc-mem-editor");
      if (ta) {
        ta.focus();
        ta.addEventListener("input", () => {
          ta.dataset.dirty = "1";
        });
      }
      const back = document.getElementById("sc-mem-back");
      if (back) back.addEventListener("click", () => loadMemory());
      const save = document.getElementById("sc-mem-save");
      if (save) {
        save.addEventListener("click", async () => {
          const val = ta ? ta.value : "";
          try {
            if (!api.memory_set) {
              toast("记忆写入接口不可用");
              return;
            }
            const r2 = await api.memory_set(key, val);
            if (r2 && r2.error) toast(r2.error);
            else {
              if (ta) ta.dataset.dirty = "";
              toast("已保存记忆：" + key);
            }
          } catch (e2) {
            toast(String(e2 && e2.message ? e2.message : e2));
          }
        });
      }
      const del = document.getElementById("sc-mem-del");
      if (del) {
        del.addEventListener("click", async () => {
          try {
            if (api.memory_delete) await api.memory_delete(key);
            toast("已删除记忆：" + key);
          } catch (e2) {
            toast(String(e2 && e2.message ? e2.message : e2));
          }
          loadMemory();
        });
      }
    } catch (e) {
      list.innerHTML = `<div class="sc-empty">${esc(e && e.message ? e.message : e)}</div>`;
    }
  }

'''
t = t[:start] + new_fn + t[end:]

# empty state: note categories exclusive
t = t.replace(
    "<strong>记忆</strong>：问答后「记入记忆」会写在这里；点卡片可查看与删除。",
    "<strong>记忆</strong>：问答后「记入记忆」写入备忘；偏好/备忘筛选互斥。点卡片可编辑保存或删除。",
    1,
)

p.write_text(t, encoding="utf-8")
print("companion patched")
