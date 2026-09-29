# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")

def rep(rel, a, b, count=1):
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    if a not in t:
        print("MISS", rel, a[:40])
        return
    p.write_text(t.replace(a, b, count), encoding="utf-8")
    print("OK", rel)

rep("tauri/src-tauri/Cargo.toml", 'version = "3.1.9"', 'version = "3.2.0"')
rep("tauri/src-tauri/tauri.conf.json", '"version": "3.1.9"', '"version": "3.2.0"')
rep("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.1.9"', 'VERSION: &str = "3.2.0"')
rep("scripts/bump_lock.py", "3.1.9", "3.2.0")

p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.2.0] - 2026-09-29

### 新增：AI 入口收敛 + 伴读侧栏
- 顶栏新增 **伴读**（Alt+I）：问答 / 知识检索 / 记忆 三栏，简约工具风（无 emoji）
- 选区 **✦** 仍为快速问答（Alt+E）；「模型」只管配置
- 新增 **StuartAIService**：统一消息 / 流式（`text` 字段）/ 取消，浮层与伴读共用
- 知识检索：工作区 Markdown `search_md`（本机检索，**不含向量库**，后续再加）
- 记忆面板：列出 `memory` 键，可按偏好/备忘筛选
- 欢迎页快捷键说明更新（Alt+E / Alt+I）

### 规范
- 伴读/面板使用主题 Token；功能图标为线性 SVG
- 版本线：本波为 **3.2.0**；向量库与更深 AI 原生回写放在后续 3.3.x

"""
if "## [3.2.0]" not in t:
    p.write_text(t.replace("## [3.1.9]", block + "## [3.1.9]", 1), encoding="utf-8")
    print("OK CHANGELOG")

for rel in ("README.md",):
    p = ROOT / rel
    if p.exists():
        t = p.read_text(encoding="utf-8").replace("3.1.9", "3.2.0")
        p.write_text(t, encoding="utf-8")
        print("OK README")

sample = ROOT / "samples/欢迎使用 StuartMD.md"
if sample.exists():
    t = sample.read_text(encoding="utf-8").replace("3.1.9", "3.2.0")
    if "伴读" not in t:
        t = t.replace("**当前版本：** 3.2.0", "**当前版本：** 3.2.0\n\n- 顶栏 **伴读**（Alt+I）：问答 / 知识 / 记忆\n- 选中文字 **✦** 或 Alt+E：快速问答")
    sample.write_text(t, encoding="utf-8")
    print("OK sample")

selftest = ROOT / "scripts/selftest_3_0_0.py"
t = selftest.read_text(encoding="utf-8")
t = t.replace("3.1.9", "3.2.0")
if "ai-service" not in t:
    t += '''
check("StuartAIService" in read("web/js/core/ai-service.js"), "ai-service module")
check("companion.js" in html, "companion script loaded")
check("btn-companion" in html, "companion topbar button")
check("StuartCompanion" in read("web/js/ui/companion.js"), "companion host")
check("3.2.0" in changelog and "伴读" in changelog, "CHANGELOG 3.2.0")
'''
selftest.write_text(t, encoding="utf-8")
print("OK selftest")
print("done")
