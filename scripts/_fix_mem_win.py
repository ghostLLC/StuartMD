# -*- coding: utf-8 -*-
from pathlib import Path

# 1) Insert showMemoryDetail function
p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\js\ui\companion.js")
t = p.read_text(encoding="utf-8")
fn = """
  async function showMemoryDetail(key) {
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
            <button type="button" class="btn sm" id="sc-mem-back">返回列表</button>
            <button type="button" class="btn sm" id="sc-mem-del">删除</button>
          </div>
          <div class="sc-card-title">${esc(key)}</div>
          <pre class="sc-detail-body">${esc(err || body || "（空）")}</pre>
        </div>`;
      const back = document.getElementById("sc-mem-back");
      if (back) back.addEventListener("click", () => loadMemory());
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
"""
if "async function showMemoryDetail" not in t:
    t = t.replace("  global.StuartCompanion = {", fn + "\n  global.StuartCompanion = {", 1)
    p.write_text(t, encoding="utf-8")
    print("showMemoryDetail inserted")
else:
    print("showMemoryDetail already present")

# 2) Window default: smaller, fit under 85% of 1080p; clamp restore in rust
conf = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\tauri\src-tauri\tauri.conf.json")
ct = conf.read_text(encoding="utf-8")
ct = ct.replace('"width": 1280', '"width": 1100').replace('"height": 820', '"height": 720')
ct = ct.replace('"minWidth": 900', '"minWidth": 880').replace('"minHeight": 580', '"minHeight": 560')
conf.write_text(ct, encoding="utf-8")
print("tauri.conf window 1100x720")

# 3) Clamp restored window size to work area in win_api
wp = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\tauri\src-tauri\src\win_api.rs")
wt = wp.read_text(encoding="utf-8")
needle = "    let width = ws.get(\"width\")"
if "fit_window_size" not in wt and needle in wt:
    helper = """
    fn fit_dim(v: i64, lo: i64, hi: i64) -> i64 {
        if v <= 0 { return lo; }
        v.clamp(lo, hi)
    }
    // Monitor work area (fallback 1366x768)
    let (mw, mh) = (1366i64, 768i64);
    #[cfg(target_os = "windows")]
    let (mw, mh) = {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
        unsafe { (GetSystemMetrics(SM_CXSCREEN) as i64, GetSystemMetrics(SM_CYSCREEN) as i64) }
    };
    let max_w = (mw as f64 * 0.92) as i64;
    let max_h = (mh as f64 * 0.90) as i64;
"""
    # insert helper before width line and clamp after width/height parse - simpler: wrap set_size later
    wt = wt.replace(
        "    let width = ws.get(\"width\")",
        helper + "    let width = ws.get(\"width\")",
        1,
    )
    # find set_size or similar and clamp - search for width as u32
    import re
    wt = re.sub(
        r"(let width = ws\.get\(\"width\"\)[\s\S]{0,200}?as u32;)",
        r"\1\n    let width = fit_dim(width as i64, 880, max_w) as u32;",
        wt,
        count=1,
    )
    # height similarly if exists
    wt = re.sub(
        r"(let height = ws\.get\(\"height\"\)[\s\S]{0,200}?as u32;)",
        r"\1\n    let height = fit_dim(height as i64, 560, max_h) as u32;",
        wt,
        count=1,
    )
    wp.write_text(wt, encoding="utf-8")
    print("win_api clamped")
else:
    print("win_api skip", "fit_window_size" in wt, needle in wt)
print("done")
