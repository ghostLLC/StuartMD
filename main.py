"""StuartMD — production desktop entry (pywebview)."""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import webview

APP_NAME = "StuartMD"
APP_ID = "StuartMD"
VERSION = "1.10.0"
PUBLISHER = "StuartMD"
PROG_ID = "StuartMD.Markdown"
GITHUB_REPO = "ghostLLC/StuartMD"
GITHUB_RELEASES_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
GITHUB_RELEASES_PAGE = f"https://github.com/{GITHUB_REPO}/releases/latest"
SETTINGS_SCHEMA = 2

MD_EXTS = {".md", ".markdown", ".mdown", ".mkd", ".txt"}
PDF_EXTS = {".pdf"}
DOC_EXTS = MD_EXTS | PDF_EXTS
PDF_MAX_BYTES = 40 * 1024 * 1024


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_root() -> Path:
    """Directory that holds web assets / icon (bundled or source)."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def install_dir() -> Path:
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    """Persistent user settings directory (roaming AppData)."""
    base = os.environ.get("APPDATA")
    if base:
        d = Path(base) / APP_ID
    else:
        d = Path.home() / "AppData" / "Roaming" / APP_ID
    d.mkdir(parents=True, exist_ok=True)
    return d


def settings_path() -> Path:
    return data_dir() / "settings.json"


def local_state_path() -> Path:
    d = data_dir() / "Local"
    d.mkdir(parents=True, exist_ok=True)
    return d / "state.json"


def annotations_dir() -> Path:
    d = data_dir() / "pdf_annotations"
    d.mkdir(parents=True, exist_ok=True)
    return d


def plugins_dir() -> Path:
    d = data_dir() / "plugins"
    d.mkdir(parents=True, exist_ok=True)
    return d


def wallpapers_dir() -> Path:
    d = data_dir() / "wallpapers"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return "#{:02x}{:02x}{:02x}".format(max(0, min(255, int(r))), max(0, min(255, int(g))), max(0, min(255, int(b))))


def extract_dominant_colors(img) -> list:
    """Return 4 accent colors from image: bg, surface, accent, text-ish."""
    try:
        from PIL import Image
        small = img.copy()
        small.thumbnail((80, 80), Image.Resampling.BOX)
        pixels = list(small.getdata())
        if not pixels:
            return ["#f5f5f5", "#ffffff", "#333333", "#222222"]
        # average
        n = len(pixels)
        avg = (
            sum(p[0] for p in pixels) / n,
            sum(p[1] for p in pixels) / n,
            sum(p[2] for p in pixels) / n,
        )
        # most saturated vivid pixel cluster (simple bucket)
        def sat(p):
            r, g, b = p
            mx, mn = max(p), min(p)
            return mx - mn

        vivid = sorted(pixels, key=sat, reverse=True)[: max(8, n // 20)]
        if not vivid:
            vivid = pixels
        vr = sum(p[0] for p in vivid) / len(vivid)
        vg = sum(p[1] for p in vivid) / len(vivid)
        vb = sum(p[2] for p in vivid) / len(vivid)

        lum = 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2]
        dark = lum < 128

        bg = _rgb_to_hex(*avg)
        # lighten/darken surface
        if dark:
            surface = _rgb_to_hex(avg[0] * 0.85, avg[1] * 0.85, avg[2] * 0.85)
            text = "#f2f2f2"
            text2 = "#c8c8c8"
        else:
            surface = _rgb_to_hex(min(255, avg[0] * 1.05 + 8), min(255, avg[1] * 1.05 + 8), min(255, avg[2] * 1.05 + 8))
            text = "#1a1a1a"
            text2 = "#555555"
        accent = _rgb_to_hex(vr, vg, vb)
        # ensure accent contrast: if too close to bg, mix toward vivid black/white
        return [bg, surface, accent, text, text2]
    except Exception:
        return ["#f5f5f5", "#ffffff", "#333333", "#222222", "#666666"]


def annot_key(path: str) -> str:
    return hashlib.sha1(str(Path(path).resolve()).encode("utf-8", "replace")).hexdigest()


def annot_path(path: str) -> Path:
    return annotations_dir() / f"{annot_key(path)}.json"


WEB_DIR = app_root() / "web"
ICON_PATH = app_root() / "assets" / "app.ico"

# Single-instance named mutex (Windows)
_MUTEX_NAME = "Local\\StuartMD_SingleInstance_Mutex"
_mutex_handle = None


def acquire_single_instance() -> bool:
    global _mutex_handle
    kernel32 = ctypes.windll.kernel32
    ERROR_ALREADY_EXISTS = 183
    _mutex_handle = kernel32.CreateMutexW(None, False, _MUTEX_NAME)
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        return False
    return True


def release_single_instance() -> None:
    global _mutex_handle
    if _mutex_handle:
        ctypes.windll.kernel32.CloseHandle(_mutex_handle)
        _mutex_handle = None


def _load_json(path: Path, default: dict) -> dict:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default


def _save_json(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


DEFAULT_SETTINGS = {
    "schema_version": SETTINGS_SCHEMA,
    "recent": [],
    "theme": "light",
    "last_folder": "",
    "sidebar": True,
    "mode": "preview",
    "autosave": True,
    "glass": False,
    "language": "zh-CN",
    "plugins_disabled": [],
    "wallpaper": {},
    "app_version": VERSION,
    "open_mode": "smart",
    "new_doc_mode": "tab",
    "music": {"volume": 0.4, "currentId": "rain", "customName": "", "playing": False},
}


def migrate_settings(raw: dict | None) -> dict:
    """Upgrade old settings in place; keep all user data intact."""
    s = dict(raw or {})
    from_v = int(s.get("schema_version") or 1)

    # v1 → v2: language / plugins / wallpaper / app_version
    if from_v < 2:
        s.setdefault("language", "zh-CN")
        s.setdefault("plugins_disabled", [])
        if "wallpaper" not in s:
            s["wallpaper"] = {}
        # glass theme removed; migrate to light
        if s.get("theme") in ("glass", "frosted"):
            s["theme"] = "light"
        s["glass"] = False
        theme = s.get("theme")
        if theme in ("Stuart", "MiniTypora"):
            s["theme"] = "light"

    # ensure required keys exist
    for k, v in DEFAULT_SETTINGS.items():
        if k not in s:
            s[k] = v

    s["schema_version"] = SETTINGS_SCHEMA
    s["app_version"] = VERSION
    return s


def _parse_version(v: str) -> tuple:
    parts = []
    for x in str(v).strip().lstrip("vV").split("."):
        num = ""
        for ch in x:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num or 0))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


class API:
    def __init__(self, startup_file: str | None = None) -> None:
        self._window = None
        self.startup_file = startup_file
        raw = _load_json(settings_path(), None)
        self.settings = migrate_settings(raw if isinstance(raw, dict) else None)
        # Persist migrated settings (seamless upgrade)
        _save_json(settings_path(), self.settings)

    def bind_window(self, window) -> None:
        self._window = window

    # ---------- meta ----------
    def get_app_info(self) -> dict:
        return {
            "name": APP_NAME,
            "version": VERSION,
            "publisher": PUBLISHER,
            "data_dir": str(data_dir()),
            "install_dir": str(install_dir()),
            "exe": sys.executable if is_frozen() else str(install_dir() / "main.py"),
            "frozen": is_frozen(),
            "startup_file": self.startup_file,
            "prog_id": PROG_ID,
            "plugins_dir": str(plugins_dir()),
            "wallpapers_dir": str(wallpapers_dir()),
            "languages": ["zh-CN", "zh-TW", "en-US"],
            "github": f"https://github.com/{GITHUB_REPO}",
            "schema_version": SETTINGS_SCHEMA,
        }

    # ---------- updates ----------
    def check_update(self) -> dict:
        """Check GitHub Releases for a newer version."""
        try:
            import urllib.request
            import urllib.error

            req = urllib.request.Request(
                GITHUB_RELEASES_API,
                headers={
                    "User-Agent": f"{APP_NAME}/{VERSION}",
                    "Accept": "application/vnd.github+json",
                },
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            remote = str(data.get("tag_name") or data.get("name") or "").lstrip("vV")
            if not remote:
                return {"ok": True, "update": False, "current": VERSION, "error": "无法解析版本号"}
            latest = remote.strip()
            newer = _parse_version(latest) > _parse_version(VERSION)
            asset_url = GITHUB_RELEASES_PAGE
            for a in data.get("assets") or []:
                name = (a.get("name") or "").lower()
                if name.endswith(".exe") and "setup" in name:
                    asset_url = a.get("browser_download_url") or asset_url
                    break
            return {
                "ok": True,
                "update": newer,
                "current": VERSION,
                "latest": latest,
                "notes": data.get("body") or "",
                "url": data.get("html_url") or GITHUB_RELEASES_PAGE,
                "download_url": asset_url,
                "published_at": data.get("published_at") or "",
            }
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {
                    "ok": True,
                    "update": False,
                    "current": VERSION,
                    "latest": VERSION,
                    "error": "仓库尚无 Release，当前已是可用版本",
                }
            return {"ok": False, "error": f"检查更新失败：HTTP {e.code}"}
        except Exception as e:
            return {"ok": False, "error": f"检查更新失败：{e}"}

    def open_url(self, url: str) -> bool:
        try:
            if url and url.startswith("http"):
                os.startfile(url)
                return True
        except Exception:
            pass
        return False

    # ---------- plugins ----------
    def list_plugins(self) -> dict:
        """Discover JS plugins from AppData and install dir."""
        found = []
        roots = [plugins_dir(), install_dir() / "plugins"]
        for root in roots:
            if not root.exists():
                continue
            for p in sorted(root.glob("*.js")):
                try:
                    meta = {"id": p.stem, "path": str(p), "name": p.stem, "enabled": True}
                    mf = p.with_suffix(".json")
                    if mf.exists():
                        meta.update(json.loads(mf.read_text(encoding="utf-8")))
                    # optional disable list
                    disabled = set(self.settings.get("plugins_disabled") or [])
                    meta["enabled"] = meta.get("id") not in disabled
                    found.append(meta)
                except Exception:
                    continue
        return {"plugins": found, "dir": str(plugins_dir())}

    def read_plugin_source(self, path: str) -> dict:
        try:
            p = Path(path)
            if not p.exists():
                return {"error": "插件不存在"}
            return {"path": str(p), "source": p.read_text(encoding="utf-8", errors="replace")}
        except Exception as e:
            return {"error": str(e)}

    def set_plugin_enabled(self, plugin_id: str, enabled: bool) -> dict:
        try:
            disabled = set(self.settings.get("plugins_disabled") or [])
            if enabled:
                disabled.discard(plugin_id)
            else:
                disabled.add(plugin_id)
            self.settings["plugins_disabled"] = sorted(disabled)
            self.save_settings({})
            return {"ok": True, "disabled": sorted(disabled)}
        except Exception as e:
            return {"error": str(e)}

    def open_plugins_dir(self) -> bool:
        try:
            os.startfile(str(plugins_dir()))
            return True
        except Exception:
            return False

    # ---------- wallpaper ----------
    def import_wallpaper(self, b64: str, name: str = "wallpaper.png") -> dict:
        """Save uploaded wallpaper image and extract dominant colors."""
        try:
            from PIL import Image
            import io

            raw = base64.b64decode(b64.split(",")[-1])
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            # cap size for storage
            img.thumbnail((1920, 1080), Image.Resampling.LANCZOS)
            safe = "".join(c for c in (name or "wallpaper") if c.isalnum() or c in "._- ") or "wallpaper.png"
            if not safe.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                safe = safe + ".png"
            out = wallpapers_dir() / safe
            img.save(out, format="PNG")
            colors = extract_dominant_colors(img)
            self.settings["wallpaper"] = {"path": str(out), "colors": colors}
            self.settings["theme"] = "wallpaper"
            self.save_settings({})
            return {"ok": True, "path": str(out), "colors": colors, "uri": out.as_uri()}
        except Exception as e:
            return {"error": str(e)}

    def get_wallpaper(self) -> dict:
        wp = self.settings.get("wallpaper") or {}
        path = wp.get("path")
        if path and Path(path).exists():
            try:
                uri = Path(path).as_uri()
            except Exception:
                uri = ""
            return {**wp, "uri": uri}
        return {}

    def clear_wallpaper(self) -> dict:
        try:
            self.settings.pop("wallpaper", None)
            if self.settings.get("theme") == "wallpaper":
                self.settings["theme"] = "light"
            self.save_settings({})
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    # ---------- settings (AppData, persistent) ----------
    def get_settings(self) -> dict:
        s = dict(self.settings)
        s["recent"] = s.get("recent", [])[:20]
        return s

    def save_settings(self, data: dict) -> bool:
        try:
            if data:
                self.settings.update(data)
            _save_json(settings_path(), self.settings)
            return True
        except Exception:
            return False

    # ---------- dialogs & files ----------
    def open_file_dialog(self, suggested: str | None = None) -> dict | None:
        try:
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=(
                    "文档 (*.md;*.markdown;*.mdown;*.mkd;*.pdf;*.txt)",
                    "Markdown (*.md;*.markdown)",
                    "PDF (*.pdf)",
                    "文本 (*.txt)",
                    "All files (*.*)",
                ),
            )
            if not result:
                return None
            path = result[0] if isinstance(result, (list, tuple)) else str(result)
            return self.read_file(path)
        except Exception as e:
            return {"error": str(e)}

    def open_folder_dialog(self) -> str | None:
        try:
            result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
            if not result:
                return None
            path = result[0] if isinstance(result, (list, tuple)) else str(result)
            self.settings["last_folder"] = path
            self._push_recent(path, "folder")
            self.save_settings({})
            return path
        except Exception:
            return None

    def save_file_dialog(self, content: str, suggested_name: str = "untitled.md") -> dict | None:
        try:
            result = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=("Markdown (*.md;*.markdown)", "文本 (*.txt)"),
            )
            if not result:
                return None
            path = result[0] if isinstance(result, (list, tuple)) else str(result)
            if not path.lower().endswith((".md", ".markdown", ".txt")):
                path = path + ".md"
            Path(path).write_text(content or "", encoding="utf-8")
            self._push_recent(path, "file")
            return {"path": path, "ok": True}
        except Exception as e:
            return {"error": str(e)}

    def read_file(self, path: str) -> dict:
        try:
            p = Path(path)
            if not p.exists():
                return {"error": f"文件不存在: {path}"}
            if not p.is_file():
                return {"error": f"不是文件: {path}"}
            if p.suffix.lower() in PDF_EXTS:
                return self.read_pdf(str(p))
            size = p.stat().st_size
            if size > 8 * 1024 * 1024:
                return {"error": "文件过大（>8MB），请用其他工具打开"}
            text = p.read_text(encoding="utf-8", errors="replace")
            self._push_recent(str(p), "file")
            return {"path": str(p), "name": p.name, "content": text, "size": size, "kind": "markdown"}
        except Exception as e:
            return {"error": str(e)}

    def read_pdf(self, path: str) -> dict:
        """Return PDF metadata + base64 payload for pdf.js (offline)."""
        try:
            p = Path(path)
            if not p.exists():
                return {"error": f"文件不存在: {path}"}
            size = p.stat().st_size
            if size > PDF_MAX_BYTES:
                return {"error": f"PDF 过大（>{PDF_MAX_BYTES // (1024*1024)}MB）"}
            data = p.read_bytes()
            b64 = base64.b64encode(data).decode("ascii")
            self._push_recent(str(p), "file")
            return {
                "kind": "pdf",
                "path": str(p),
                "name": p.name,
                "size": size,
                "b64": b64,
                "annotations": self.load_annotations(str(p)),
            }
        except Exception as e:
            return {"error": str(e)}

    def load_annotations(self, pdf_path: str) -> list:
        try:
            ap = annot_path(pdf_path)
            if not ap.exists():
                return []
            obj = json.loads(ap.read_text(encoding="utf-8"))
            if isinstance(obj, list):
                return obj
            return obj.get("items", [])
        except Exception:
            return []

    def save_annotations(self, pdf_path: str, items: list) -> dict:
        try:
            ap = annot_path(pdf_path)
            payload = {
                "pdf": str(Path(pdf_path).resolve()),
                "items": items or [],
            }
            tmp = ap.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(ap)
            return {"ok": True, "count": len(items or [])}
        except Exception as e:
            return {"error": str(e)}

    def add_annotation(self, pdf_path: str, ann: dict) -> dict:
        try:
            items = self.load_annotations(pdf_path)
            ann = dict(ann or {})
            ann.setdefault("id", uuid.uuid4().hex)
            ann.setdefault("type", "highlight")
            ann.setdefault("color", "#fff59d")
            ann.setdefault("created", __import__("time").time())
            items.append(ann)
            return self.save_annotations(pdf_path, items)
        except Exception as e:
            return {"error": str(e)}

    def delete_annotation(self, pdf_path: str, ann_id: str) -> dict:
        try:
            items = [a for a in self.load_annotations(pdf_path) if a.get("id") != ann_id]
            return self.save_annotations(pdf_path, items)
        except Exception as e:
            return {"error": str(e)}

    def clear_annotations(self, pdf_path: str) -> dict:
        return self.save_annotations(pdf_path, [])

    def write_file(self, path: str, content: str) -> dict:
        try:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content or "", encoding="utf-8")
            self._push_recent(str(p), "file")
            return {"path": str(p), "ok": True}
        except Exception as e:
            return {"error": str(e)}

    def export_html(self, html: str, suggested_name: str = "export.html") -> dict | None:
        try:
            result = self._window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=("HTML (*.html)",),
            )
            if not result:
                return None
            path = result[0] if isinstance(result, (list, tuple)) else str(result)
            if not path.lower().endswith(".html"):
                path = path + ".html"
            Path(path).write_text(html or "", encoding="utf-8")
            return {"path": path, "ok": True}
        except Exception as e:
            return {"error": str(e)}

    def open_sample(self) -> dict:
        # Prefer packaged sample, then install dir, then source tree
        candidates = [
            app_root() / "samples" / "示例文档.md",
            install_dir() / "samples" / "示例文档.md",
        ]
        for sample in candidates:
            if sample.exists():
                return self.read_file(str(sample))
        return {
            "path": None,
            "name": "示例文档.md",
            "content": (
                "# StuartMD 示例\n\n"
                "这是一份内置示例文档。\n\n"
                "## 支持的语法\n\n"
                "- **加粗**、*斜体*、~~删除线~~\n"
                "- 表格、任务列表、代码高亮\n"
                "- 行内 $E=mc^2$ 与块级公式\n\n"
                "$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n"
            ),
            "size": 0,
        }

    def open_welcome(self) -> dict:
        """Default intro document shown on app start (no file argument)."""
        candidates = [
            app_root() / "samples" / "欢迎使用 StuartMD.md",
            install_dir() / "samples" / "欢迎使用 StuartMD.md",
        ]
        for sample in candidates:
            if sample.exists():
                data = self.read_file(str(sample))
                if not data.get("error"):
                    data["welcome"] = True
                    return data
        return {
            "path": None,
            "name": "欢迎使用 StuartMD.md",
            "kind": "markdown",
            "welcome": True,
            "content": (
                "# StuartMD\n\n"
                "轻量 Markdown 阅读与编辑器。\n\n"
                "## 功能\n\n"
                "- Markdown 阅读 / 编辑 / 自动保存\n"
                "- LaTeX 公式、Mermaid 图表、代码高亮\n"
                "- PDF 阅读与标黄\n"
                "- 主题、壁纸、插件、多语言\n"
            ),
            "size": 0,
        }

    # ---------- folder tree ----------
    def read_dir_tree(self, path: str, max_depth: int = 3) -> dict:
        try:
            root = Path(path)
            if not root.is_dir():
                return {"error": "目录不存在"}

            def walk(dir_path: Path, depth: int) -> list:
                if depth > max_depth:
                    return []
                items = []
                try:
                    entries = sorted(
                        dir_path.iterdir(),
                        key=lambda x: (0 if x.is_dir() else 1, x.name.lower()),
                    )
                except PermissionError:
                    return []
                for entry in entries:
                    if entry.name.startswith("."):
                        continue
                    if entry.is_dir():
                        children = walk(entry, depth + 1)
                        has_md = False
                        try:
                            for c in entry.iterdir():
                                if c.is_file() and not c.name.startswith(".") and c.suffix.lower() in DOC_EXTS:
                                    has_md = True
                                    break
                        except Exception:
                            pass
                        if children or has_md:
                            items.append(
                                {
                                    "name": entry.name,
                                    "path": str(entry),
                                    "type": "dir",
                                    "children": children,
                                }
                            )
                    elif entry.suffix.lower() in DOC_EXTS:
                        items.append({"name": entry.name, "path": str(entry), "type": "file"})
                return items

            return {"path": str(root), "name": root.name, "items": walk(root, 1)}
        except Exception as e:
            return {"error": str(e)}

    def resolve_asset(self, base_file: str, rel: str) -> str | None:
        try:
            if not base_file or not rel:
                return None
            if rel.startswith(("http://", "https://", "data:", "file://")):
                return rel
            base = Path(base_file).parent
            target = (base / rel).resolve()
            if target.exists() and target.is_file():
                return target.as_uri()
        except Exception:
            pass
        return None

    # ---------- recents ----------
    def get_recents(self) -> list:
        return self.settings.get("recent", [])[:12]

    def _push_recent(self, path: str, kind: str) -> None:
        recents = [r for r in self.settings.get("recent", []) if r.get("path") != path]
        recents.insert(0, {"path": path, "name": Path(path).name, "kind": kind})
        self.settings["recent"] = recents[:20]
        self.save_settings({})

    def open_path(self, path: str) -> dict:
        p = Path(path)
        if p.is_dir():
            self.settings["last_folder"] = str(p)
            self.save_settings({})
            return {"kind": "folder", "path": str(p)}
        data = self.read_file(str(p))
        if data.get("error"):
            return data
        # read_file sets kind=markdown/pdf; keep a stable kind= for boot
        data["kind"] = data.get("kind") or ("pdf" if p.suffix.lower() == ".pdf" else "file")
        if data["kind"] not in ("pdf", "markdown"):
            data["kind"] = "markdown" if p.suffix.lower() != ".pdf" else "pdf"
        return data

    # ---------- Windows file association ----------
    def get_file_association_status(self) -> dict:
        """Report whether StuartMD is registered as a .md handler."""
        import winreg

        registered = False
        default_cmd = ""
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\.md") as key:
                val, _ = winreg.QueryValueEx(key, "")
                registered = val == PROG_ID or str(val).startswith(APP_ID)
        except Exception:
            pass
        try:
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, rf"Software\Classes\{PROG_ID}\shell\open\command"
            ) as key:
                default_cmd, _ = winreg.QueryValueEx(key, "")
        except Exception:
            pass
        return {"registered": registered, "command": default_cmd}

    def register_file_association(self) -> dict:
        """Register StuartMD under HKCU as handler for .md/.markdown/.txt (optional)."""
        import winreg

        try:
            exe = str(install_dir() / "StuartMD.exe") if is_frozen() else sys.executable
            if is_frozen():
                cmd = f'"{exe}" "%1"'
                icon = f"{exe},0"
            else:
                main_py = str(install_dir() / "main.py")
                cmd = f'"{sys.executable}" "{main_py}" "%1"'
                icon = str(ICON_PATH) if ICON_PATH.exists() else ""

            classes = winreg.HKEY_CURRENT_USER
            for ext in (".md", ".markdown", ".mdown", ".mkd"):
                with winreg.CreateKeyEx(classes, rf"Software\Classes\{ext}", 0, winreg.KEY_SET_VALUE) as k:
                    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, PROG_ID)

            with winreg.CreateKeyEx(classes, rf"Software\Classes\{PROG_ID}", 0, winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "Markdown 文档")

            if icon:
                with winreg.CreateKeyEx(
                    classes, rf"Software\Classes\{PROG_ID}\DefaultIcon", 0, winreg.KEY_SET_VALUE
                ) as k:
                    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, icon)

            with winreg.CreateKeyEx(
                classes, rf"Software\Classes\{PROG_ID}\shell\open\command", 0, winreg.KEY_SET_VALUE
            ) as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, cmd)

            # App Paths so Win+R / shell can launch StuartMD
            if is_frozen():
                with winreg.CreateKeyEx(
                    classes, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\StuartMD.exe",
                    0, winreg.KEY_SET_VALUE,
                ) as k:
                    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(install_dir() / "StuartMD.exe"))
                    winreg.SetValueEx(k, "Path", 0, winreg.REG_SZ, str(install_dir()))

            return {"ok": True, "command": cmd}
        except Exception as e:
            return {"error": str(e)}

    def open_default_apps_settings(self) -> bool:
        """Open Windows Default Apps page so user can pick StuartMD for .md."""
        try:
            os.startfile("ms-settings:defaultapps")
            return True
        except Exception:
            try:
                os.system("start ms-settings:defaultapps")
                return True
            except Exception:
                return False

    def set_theme_glass(self, enabled: bool) -> dict:
        """Persist frosted-glass preference. Full transparency needs restart."""
        try:
            self.settings["glass"] = bool(enabled)
            if enabled:
                self.settings["theme"] = "glass"
            elif self.settings.get("theme") in ("glass", "frosted"):
                self.settings["theme"] = "light"
            self.save_settings({})
            return {
                "ok": True,
                "glass": bool(enabled),
                "theme": self.settings.get("theme"),
                "need_restart": True,
            }
        except Exception as e:
            return {"error": str(e)}

    def reopen_window(self) -> dict:
        """Relaunch this document/app (kept for compatibility)."""
        try:
            if is_frozen():
                exe = str(install_dir() / "StuartMD.exe")
                cmd = [exe]
            else:
                main_py = str(install_dir() / "main.py")
                cmd = [sys.executable, main_py]
            if self.startup_file:
                cmd.append(str(self.startup_file))
            subprocess.Popen(cmd, cwd=str(install_dir()), close_fds=True)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def open_data_dir(self) -> bool:
        try:
            os.startfile(str(data_dir()))
            return True
        except Exception:
            return False

    def reveal_in_explorer(self, path: str | None = None) -> bool:
        try:
            target = path or (str(install_dir() / "StuartMD.exe") if is_frozen() else str(install_dir()))
            if Path(target).is_file():
                os.system(f'explorer /select,"{target}"')
            else:
                os.startfile(target)
            return True
        except Exception:
            return False

    def open_in_new_window(self, path: str | None = None) -> dict:
        """Spawn a new StuartMD process/window for a file or folder."""
        target = path or self.startup_file
        if not target:
            return {"error": "未指定文件路径"}
        p = Path(target)
        if not p.exists():
            return {"error": f"文件不存在: {target}"}

        try:
            if is_frozen():
                exe = str(install_dir() / "StuartMD.exe")
                cmd = [exe, str(p.resolve())]
            else:
                main_py = str(install_dir() / "main.py")
                cmd = [sys.executable, main_py, str(p.resolve())]
            subprocess.Popen(cmd, cwd=str(install_dir()), close_fds=True)
            return {"ok": True, "path": str(p.resolve()), "kind": "folder" if p.is_dir() else "file"}
        except Exception as e:
            return {"error": str(e)}

    def open_new_window(self) -> dict:
        """Open an empty new application window."""
        try:
            if is_frozen():
                exe = str(install_dir() / "StuartMD.exe")
                cmd = [exe]
            else:
                main_py = str(install_dir() / "main.py")
                cmd = [sys.executable, main_py]
            subprocess.Popen(cmd, cwd=str(install_dir()), close_fds=True)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    def quit_app(self) -> None:
        if self._window:
            self._window.destroy()


def parse_startup_file() -> str | None:
    args = sys.argv[1:]
    for a in args:
        if a.startswith("-"):
            continue
        p = Path(a)
        if p.exists():
            return str(p.resolve())
    return None


def _get_hwnd(window) -> int:
    """Best-effort HWND from a pywebview window on Windows."""
    try:
        native = getattr(window, "native", None)
        if native is not None:
            handle = getattr(native, "Handle", None)
            if handle is not None:
                return int(handle)
    except Exception:
        pass
    try:
        user32 = ctypes.windll.user32
        title = getattr(window, "title", None) or APP_NAME
        hwnd = user32.FindWindowW(None, str(title))
        if hwnd:
            return int(hwnd)
    except Exception:
        pass
    return 0


def apply_glass_backdrop(window) -> bool:
    """Enable Windows 11 Mica / acrylic-like backdrop so wallpaper shows through."""
    hwnd = _get_hwnd(window)
    if not hwnd:
        return False
    try:
        # Extend frame so DWM composition covers the client area
        # DWMWA_SYSTEMBACKDROP_TYPE = 38
        # DWMSBT_TRANSIENTWINDOW = 3 (acrylic), DWMSBT_MAINWINDOW = 2 (mica)
        dwm = ctypes.windll.dwmapi
        DWMWA_SYSTEMBACKDROP_TYPE = 38
        DWMSBT_TRANSIENTWINDOW = 3
        DWMSBT_MAINWINDOW = 2
        value = ctypes.c_int(DWMSBT_TRANSIENTWINDOW)
        hr = dwm.DwmSetWindowAttribute(
            hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ctypes.byref(value), ctypes.sizeof(value)
        )
        if hr != 0:
            value = ctypes.c_int(DWMSBT_MAINWINDOW)
            dwm.DwmSetWindowAttribute(
                hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ctypes.byref(value), ctypes.sizeof(value)
            )
        # DWMWA_USE_IMMERSIVE_DARK_MODE = 20 — keep light for glass
        # Allow blur behind for older Win10 path
        try:
            # SetWindowCompositionAttribute: ACCENT_ENABLE_ACRYLICBLURBEHIND = 4
            class ACCENTPOLICY(ctypes.Structure):
                _fields_ = [
                    ("AccentState", ctypes.c_int),
                    ("AccentFlags", ctypes.c_int),
                    ("GradientColor", ctypes.c_uint),
                    ("AnimationId", ctypes.c_int),
                ]

            class WINCOMPATTRDATA(ctypes.Structure):
                _fields_ = [
                    ("Attribute", ctypes.c_int),
                    ("pvData", ctypes.c_void_p),
                    ("cbData", ctypes.c_size_t),
                ]

            user32 = ctypes.windll.user32
            WCA_ACCENT_POLICY = 19
            ACCENT_ENABLE_ACRYLICBLURBEHIND = 4
            # ABGR: alpha<<24 | blue<<16 | green<<8 | red
            # soft warm white with ~40% opacity
            gradient = (0x66 << 24) | (0xF8 << 16) | (0xF4 << 8) | 0xEC
            accent = ACCENTPOLICY(ACCENT_ENABLE_ACRYLICBLURBEHIND, 2, gradient, 0)
            data = WINCOMPATTRDATA(
                WCA_ACCENT_POLICY, ctypes.cast(ctypes.pointer(accent), ctypes.c_void_p), ctypes.sizeof(accent)
            )
            user32.SetWindowCompositionAttribute(hwnd, ctypes.byref(data))
        except Exception:
            pass
        return True
    except Exception:
        return False


def wants_glass(settings: dict) -> bool:
    theme = (settings or {}).get("theme") or ""
    glass = bool((settings or {}).get("glass"))
    return glass or theme in ("glass", "frosted")


def main() -> None:
    # Multi-window: each process is one window. Opening a .md via association
    # or CLI always creates a new instance so several docs can be viewed side by side.
    html = WEB_DIR / "index.html"
    if not html.exists():
        try:
            ctypes.windll.user32.MessageBoxW(
                0, f"缺少界面资源:\n{html}", APP_NAME, 0x10
            )
        except Exception:
            print(f"UI not found: {html}", file=sys.stderr)
        sys.exit(1)

    startup = parse_startup_file()
    api = API(startup_file=startup)
    glass = wants_glass(api.settings)

    title = APP_NAME
    if startup:
        try:
            title = f"{Path(startup).name} — {APP_NAME}"
        except Exception:
            pass

    try:
        window = webview.create_window(
            title,
            url=str(html),
            js_api=api,
            width=1280,
            height=820,
            min_size=(900, 580),
            # pywebview only accepts #RRGGBB (no alpha). Transparency via transparent=True.
            background_color="#ffffff",
            transparent=False,
            text_select=True,
            easy_drag=False,
            confirm_close=True,
        )
        api.bind_window(window)

        def _after_start():
            return None

        webview.start(_after_start, debug=False)
    except Exception as e:
        try:
            ctypes.windll.user32.MessageBoxW(
                0,
                f"StuartMD 启动失败：\n\n{e}\n\n"
                "若问题持续，请重新安装程序，或确认系统已安装 WebView2 运行时。",
                APP_NAME,
                0x10,
            )
        except Exception:
            print(f"startup failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
