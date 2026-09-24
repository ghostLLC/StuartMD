# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
p = ROOT / "web" / "css" / "app.css"
t = p.read_text(encoding="utf-8")
old_card = """.modal-card {
  width: min(520px, 100%);
  max-height: min(640px, 90vh);
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
}"""
new_card = """.modal-card {
  width: min(880px, 96vw);
  height: min(820px, 92vh);
  max-width: 96vw;
  max-height: 92vh;
  min-width: min(480px, 94vw);
  min-height: min(360px, 70vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  resize: both;
  position: relative;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
}

.modal-head-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-zoom {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  font-family: var(--font-ui);
}

#settings-zoom-label {
  min-width: 40px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.modal-body {
  padding: 8px 20px 24px;
  overflow: auto;
  flex: 1 1 auto;
  min-height: 0;
  zoom: var(--settings-zoom, 1);
}

.settings-resize {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(100, 116, 139, 0.45) 50%);
  border-radius: 0 0 12px 0;
  z-index: 2;
}

#set-ai-section input {
  flex: 1 1 220px;
}
#ai-custom-style,
#ai-length-hint {
  min-width: 280px !important;
}"""
# normalize newlines for match
tn = t.replace("\r\n", "\n")
if old_card not in tn:
    # append overrides at end as fallback
    extra = "\n\n/* settings modal size override 3.0.8 */\n" + new_card + "\n#settings-card.modal-head, .modal-card .modal-head { cursor: move; user-select: none; }\n"
    p.write_text(t + extra, encoding="utf-8")
    print("appended overrides")
else:
    p.write_text(tn.replace(old_card, new_card, 1), encoding="utf-8")
    print("replaced modal-card")
