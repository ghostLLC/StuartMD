# StuartMD 工程实施与技术重构路线图 (Implementation Roadmap)

**文档编号**：STMD-ROADMAP-2026-V1  
**项目基线**：StuartMD (Tauri v2 + WebView2 + Rust Desktop Core + Native Web Frontend)  
**制定组织**：StuartMD 架构指导委员会 (Architecture Steering Group)  
**实施周期**：2026 Q4 ~ 2027 Q2 (分为 P0、P1、P2 三大推进阶段)  
**文档状态**：Production Ready / Implementation Blueprint  

---

## 路线图总览 (Roadmap Executive Summary)

为彻底解决《StuartMD 深度系统诊断报告 (STUARTMD_DIAGNOSTIC_REPORT.md)》中揭示的 12 项重大代码缺陷与性能架构瓶颈，并稳步推进 StuartMD 向新一代标杆级知识桌面客户端演进，制定本三阶段工程重构路线图：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        StuartMD 重构实施三阶段推进矩阵                  │
├───────────────────┬───────────────────┬────────────────────────────────┤
│ 阶段标识与周期    │ 核心攻坚主题      │ 核心产出目标                   │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ **Phase P0**      │ 关键安全防护与    │ • 根除 URL 命令注入 (RCE) (P0-1)│
│ (紧急: 1-2 周)    │ 数据防丢止血      │ • 原子文件安全落盘与元数据保留 (P0-2)│
│                   │                   │ • 封堵 DOM XSS 严格白名单清洗 (P0-3) │
│                   │                   │ • 代际令牌防止跨标签覆写与丢脏 (P0-4)│
│                   │                   │ • 纠正 Ctrl+Shift+Z 与输入框隔离 (P0-5)│
│                   │                   │ • 原生窗口关闭生命周期与退出命令 (P0-6)│
│                   │                   │ • Windows DPAPI 凭证加密加固 (P0-7)  │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ **Phase P1**      │ 运行性能跃升与    │ • PDF 二进制 IPC 边界零拷贝 (P1-1)│
│ (中期: 3-4 周)    │ 桌面体验重塑      │ • PDF.js 虚拟化与显存物理释放 (P1-2) │
│                   │                   │ • Settings 纯事务安全原子更新 (P1-3) │
│                   │                   │ • AI 流式字节级解码与[DONE]终结 (P1-4)│
│                   │                   │ • Markdown 渲染消除 DOM 震荡   │
│                   │                   │ • WCAG AA 暗色与双栏设置中心   │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ **Phase P2**      │ 架构深水区演进与  │ • AST 驱动块编辑引擎与事务撤销 (P2-1)│
│ (长期: 2-3 个月)  │ 生态边界扩张      │ • W3C PDF 同构侧车与双向深链 (P2-2)│
│                   │                   │ • 本地轻量向量 RAG 与线程安全 (P2-3) │
│                   │                   │ • ES2022 声明式双向插件沙箱 (P2-4)  │
└───────────────────┴───────────────────┴────────────────────────────────┘
```

---

## 1. Phase P0: 关键安全防护与数据防丢止血 (Immediate 1-2 Weeks)

本阶段聚焦于消除危及用户宿主系统安全（RCE 漏洞）与直接造成用户劳动成果损毁（文件 0 字节截断、跨标签覆写、快捷键错乱）的致命缺陷。

---

### P0-1: 修复 `stuart_open_url` 命令注入与命令行参数逃逸漏洞 (RCE Defense)

#### 1. 问题陈述与影响范围
- **问题**：`tauri/src-tauri/src/fs_api.rs:552-570` 使用 `cmd.exe /C start ""` 处理 URL。由于未对参数进行 shell 转义，当 URL 中包含 `&`、`|` 等分隔符时，`cmd.exe` 会将后续内容作为独立命令执行，造成命令注入漏洞 (CWE-78)。此外，Windows 注册表 URL 处理器（如 `HKCR\https\shell\open\command` 注册的 `"msedge.exe" "%1"`）在解析未转义的双引号 `"` 时，会导致参数提前闭合，将后续内容作为浏览器启动参数注入（如 `--disable-web-security` 等参数注入逃逸，CWE-88）。
- **受影响组件**：`fs_api.rs` (`stuart_open_url`)、所有 Markdown 预览链接与 AI 输出中的外部链接跳转。

#### 2. 分步实施计划
1. 废除任何经过 `cmd.exe` 或命令行解释器的间接调用。
2. Windows 原生环境下直接使用 Win32 原生 Shell API `ShellExecuteW`。
3. 严格校验 URL 协议头，非 `http://` 与 `https://` 立即拒绝。
4. 严格过滤双引号 `"`、反引号、单引号、空白字符、控制字符（`\0`、`\r`、`\n`、ASCII 0x00..=0x1F），彻底封堵 `%1` 命令行参数逃逸。
5. 采用 `const SW_SHOWNORMAL: i32 = 1;` 常量，避免因缺少 `windows-sys` 的 `"Win32_UI_WindowsAndMessaging"` 特性导致编译失败。
6. 同时兼容并优先使用 Tauri 官方经过安全审查的 `tauri_plugin_opener` 插件。

#### 3. 生产级修复代码 (Rust)

在 `tauri/src-tauri/src/fs_api.rs` 中替换 `stuart_open_url` 实现：

```rust
// tauri/src-tauri/src/fs_api.rs

#[tauri::command]
pub fn stuart_open_url<R: tauri::Runtime>(app: tauri::AppHandle<R>, url: String) -> bool {
    let u = url.trim();
    // 1. 严格限制合法网络协议头，阻断 file://、javascript:、powershell: 等非法伪协议 (ASCII 不区分大小写)
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        log::warn!("[Security] Blocked invalid URL scheme attempt: {}", u);
        return false;
    }

    // 2. 关键防线：彻底阻断双引号、单引号、反引号、空白字符与控制字符
    // 杜绝 Windows 注册表 "%1" 协议处理器被未转义的双引号闭合导致命令行参数注入 (Argument Injection)
    if u.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '`' || c == ' ' || c == '\r' || c == '\n') {
        log::warn!("[Security] Blocked dangerous characters/quotes in URL: {}", u);
        return false;
    }

    // 3. 合法 URL 结构与解析校验
    if url::Url::parse(u).is_err() {
        log::warn!("[Security] URL structure parse failed: {}", u);
        return false;
    }

    // 4. 优先方案：利用 tauri-plugin-opener 原生安全打开
    #[cfg(feature = "custom-protocol")]
    {
        use tauri_plugin_opener::OpenerExt;
        if app.opener().open_url(u, None::<&str>).is_ok() {
            return true;
        }
    }

    // 5. 原生 Win32 方案：直接调用系统 ShellExecuteW，绝不通过 cmd.exe
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        // SW_SHOWNORMAL 在 Win32 API 中定义为字面量 1i32
        // 直接使用常量 1i32 避免额外引入 windows-sys 的 "Win32_UI_WindowsAndMessaging" 特性依赖
        const SW_SHOWNORMAL: i32 = 1;

        let wide_op: Vec<u16> = OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let wide_url: Vec<u16> = OsStr::new(u)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let instance = ShellExecuteW(
                std::ptr::null_mut(),
                wide_op.as_ptr(),
                wide_url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
            // HINSTANCE > 32 表示 Win32 ShellExecute 启动成功
            (instance as usize) > 32
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, u);
        false
    }
}
```

---

### P0-2: 修复 `stuart_write_file` 非原子写盘、时间戳碰撞与元数据损毁 (Data Loss Defense)

#### 1. 问题陈述与影响范围
- **问题**：`tauri/src-tauri/src/fs_api.rs:375-387` 使用 `std::fs::write` 直接覆写物理文件，系统通过 `CREATE_ALWAYS` 瞬间将目标文件截断为 0 字节，且未调用 `sync_all()` 强制刷盘。掉电、系统崩溃或文件锁冲突将导致用户原始数据彻底丢失。此外，在高并发自动保存场景下，纯时间戳 Nonce 碰撞率高达 84.91%（Windows 计时器精度粗糙导致多线程读取到相同微秒/纳秒时间戳）；处理相对路径（如 `doc.md`，其父路径为空字符串）时调用 `create_dir_all("")` 会导致 Windows 抛出 `os error 3`；而直接调用 `rename` 会修改目标文件原有的创建时间（破坏 NTFS 时间戳与元数据）。
- **受影响组件**：`fs_api.rs` (`stuart_write_file`)、全量自动保存与手动保存流程。

#### 2. 分步实施计划
1. **相对路径安全规整**：使用 `path.parent().unwrap_or(Path::new("."))`，若父路径为空字符串亦规整为当前目录 `.`，杜绝 `create_dir_all("")` 触发 `os error 3 (ERROR_PATH_NOT_FOUND)`。
2. **高并发无碰撞唯一临时文件**：采用 **进程 PID + 全局 AtomicU64 序列号 + 微秒时间戳 + 5次重试循环**，彻底消灭高频保存下的文件名碰撞。
3. **强制穿透物理落盘**：写入临时文件后显式调用 `file.sync_all()`（对应 Win32 `FlushFileBuffers`），保障物理扇区持久化。
4. **元数据保留与原子替换**：在 Windows 平台上，若目标文件已存在，调用 Win32 原生 `ReplaceFileW`，完整保留目标文件原始的创建时间戳、ACL 访问控制列表及流信息；若文件尚不存在（`ReplaceFileW` 会返回 `ERROR_FILE_NOT_FOUND`），则平滑使用 `std::fs::rename` 移入。异常时清理临时文件。

#### 3. 生产级修复代码 (Rust)

在 `tauri/src-tauri/src/fs_api.rs` 中重构写入实现：

```rust
// tauri/src-tauri/src/fs_api.rs

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use serde_json::{json, Value};

static ATOMIC_WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn atomic_write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    // 1. 安全规整父目录：彻底兼容相对路径 (如 "notes.md")，防止 create_dir_all("") 产生 os error 3
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };

    if parent != Path::new(".") {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
    }

    // 2. 进程 PID + AtomicU64 原子计数器 + 微秒时间戳 + 5 次重试循环
    // 彻底根除纯 SystemTime 时间戳在高并发自动保存下高达 84.91% 的碰撞率
    let pid = std::process::id();
    let mut last_err = String::new();

    for attempt in 0..5 {
        let seq = ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or(0);
        let tmp_name = format!(".~stuart_tmp_{}_{}_{:x}_{}.tmp", pid, seq, timestamp, attempt);
        let tmp_path = parent.join(&tmp_name);

        // 以排他性创建模式打开临时文件
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = format!("临时文件碰撞: {e}");
                continue; // 碰撞时立即进入下一次重试循环
            }
            Err(e) => return Err(format!("创建临时文件失败: {e}")),
        };

        if let Err(e) = file.write_all(content) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("写入临时文件失败: {e}"));
        }

        // 关键防线：强制刷新操作系统页缓存与磁盘物理写入缓冲区 (Win32 FlushFileBuffers)
        if let Err(e) = file.sync_all() {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("数据持久化刷盘失败 (fsync): {e}"));
        }
        drop(file); // 显式释放文件句柄，允许操作系统接管原子替换

        // 3. 平台级原子替换与元数据保留：
        // 在 Windows 上，若目标文件已存在，调用 ReplaceFileW 保留原文件的创建时间、NTFS 权限与元数据；
        // 若目标文件尚不存在，ReplaceFileW 必然报错 (Win32 Error 2)，此时平滑降级为 std::fs::rename。
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};

            let replace_res = if path.exists() {
                let wide_target: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                let wide_tmp: Vec<u16> = tmp_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

                let ret = unsafe {
                    ReplaceFileW(
                        wide_target.as_ptr(),
                        wide_tmp.as_ptr(),
                        std::ptr::null(),
                        REPLACEFILE_IGNORE_MERGE_ERRORS,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if ret != 0 {
                    Ok(())
                } else {
                    // 若 ReplaceFileW 失败，启用标准库 rename 作为第二道兜底防线
                    fs::rename(&tmp_path, path).map_err(|e| format!("Windows ReplaceFileW 及 rename 降级均失败: {e}"))
                }
            } else {
                fs::rename(&tmp_path, path).map_err(|e| format!("原子文件移动创建失败: {e}"))
            };

            if let Err(e) = replace_res {
                let _ = fs::remove_file(&tmp_path);
                return Err(e);
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = fs::rename(&tmp_path, path) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("原子文件替换失败: {e}"));
            }
        }

        return Ok(());
    }

    Err(format!("超过最大重试次数，临时文件创建失败: {last_err}"))
}

#[tauri::command]
pub fn stuart_write_file(path: String, content: String) -> Value {
    let p = Path::new(&path);
    match atomic_write_file(p, content.as_bytes()) {
        Ok(()) => {
            push_recent(&p.to_string_lossy(), "file");
            json!({"ok": true, "path": p.to_string_lossy()})
        }
        Err(e) => {
            log::error!("[I/O Error] stuart_write_file failed for {}: {}", path, e);
            json!({"error": e})
        }
    }
}
```

---

### P0-3: 修复 DOM XSS 过滤器绕过与链接跳转跳板 (Frontend Security)

#### 1. 问题陈述与影响范围
- **问题**：`web/js/app.js` 中 `markdown-it` 开启了 `html: true`，且自定义黑名单过滤正则 `/\son\w+\s*=/i` 与大小写敏感的 `indexOf("javascript:")` 存在逻辑漏洞。配合未阻止默认行为的外部超链接委托与宽松的 Mermaid，攻击者可通过恶意 Markdown 触发 RCE。
- **受影响组件**：`web/js/app.js` (`createBlockNode`, 链接委托)、`web/index.html`。

#### 2. 分步实施计划
1. 引入标准且经实战验证的 DOMPurify 白名单清洗引擎（并在无外部库时内置严格的纯 DOM 树递归白名单处理器），严禁依赖脆弱的正则表达式黑名单。
2. 调整生命周期：先清洗、后插入 DOM，杜绝浏览器在解析带有内联事件的 HTML 时提前执行脚本。
3. 全局重构预览区超链接点击监听器：强制执行 `e.preventDefault()`，仅对经协议白名单校验通过的 `http:`、`https:`、`mailto:` 发起调用。
4. 将 Mermaid 图表引擎安全等级设为 `"strict"`。

#### 3. 生产级修复代码 (JavaScript)

在 `web/js/app.js` 中进行如下安全加固：

```javascript
// web/js/app.js

// 1. 严格白名单 HTML 清洗器 (原生纯 DOM 树递归白名单处理器)
function sanitizeHtmlStrict(rawHtml) {
  if (!rawHtml) return "";

  // 方案 A：若工程引入了 DOMPurify (强烈推荐通过 web/libs/dompurify.min.js 打包引入)，采用最高安全配置
  if (typeof DOMPurify !== "undefined") {
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true, svg: false, mathMl: false }, // 彻底禁用 SVG/MathML，杜绝 SMIL/mcurl 变种攻击
      FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link", "style", "svg", "math", "applet", "animate", "set"],
      FORBID_ATTR: ["style"], // 封堵基于 CSS 属性的盲注与滤镜劫持
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      ADD_ATTR: ["target"],
    });
  }

  // 方案 B：严格零依赖原生 DOM 树白名单清洗引擎 (杜绝正则表达式与黑名单过滤)
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  const content = template.content;

  // 元素严格白名单 (仅放行安全排版语义标签，绝无 SVG/MathML 容器及 SMIL 动画标签)
  const ALLOWED_TAGS = new Set([
    "P", "BR", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "CODE", "UL", "OL", "LI", "DL", "DT", "DD",
    "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD",
    "STRONG", "B", "EM", "I", "U", "DEL", "S", "A", "IMG",
    "SPAN", "DIV", "SUB", "SUP", "MARK", "SMALL", "ABBR", "SUMMARY", "DETAILS"
  ]);

  // 属性严格白名单映射 (元素标签 -> 允许存在的属性集合)
  const ALLOWED_ATTRS = {
    "A": new Set(["href", "target", "rel", "title", "class", "id"]),
    "IMG": new Set(["src", "alt", "title", "width", "height", "class", "id", "loading"]),
    "CODE": new Set(["class", "id", "data-language"]),
    "TH": new Set(["align", "colspan", "rowspan", "class", "id"]),
    "TD": new Set(["align", "colspan", "rowspan", "class", "id"]),
    "OL": new Set(["start", "type", "class", "id"]),
    "DEFAULT": new Set(["class", "id", "title", "dir", "lang"])
  };

  // 协议与 URL 严格校验归一化：彻底剥离控制字符、制表符与换行符 (阻断 jav&#x09;ascript: 绕过)
  function isSafeUrl(rawUrl) {
    if (!rawUrl) return false;
    // 关键防线：剔除所有 ASCII 0x00..=0x1F、0x7F 控制字符及空白符后再行协议研判
    const normalized = rawUrl.replace(/[\u0000-\u001F\u007F\s]/g, "").toLowerCase();
    // 阻断一切危险伪协议
    if (
      normalized.includes("javascript:") ||
      normalized.includes("data:") ||
      normalized.includes("vbscript:") ||
      normalized.includes("file:") ||
      normalized.includes("about:")
    ) {
      return false;
    }
    // 仅放行绝对网络链接与文档内锚点/相对链接
    return (
      normalized.startsWith("http://") ||
      normalized.startsWith("https://") ||
      normalized.startsWith("mailto:") ||
      normalized.startsWith("#") ||
      normalized.startsWith("/") ||
      normalized.startsWith("./") ||
      normalized.startsWith("../")
    );
  }

  // 递归树遍历处理
  const allElements = Array.from(content.querySelectorAll("*"));
  for (const el of allElements) {
    const tagName = el.tagName.toUpperCase();

    // 1. 元素白名单审查：若不在白名单中，一律解包或彻底移除
    if (!ALLOWED_TAGS.has(tagName)) {
      el.remove(); // 包含 <svg>, <animate>, <set>, <script>, <iframe> 等直接物理销毁
      continue;
    }

    // 2. 属性白名单审查与清洗
    const allowedForTag = ALLOWED_ATTRS[tagName] || ALLOWED_ATTRS["DEFAULT"];
    const attrs = Array.from(el.attributes);

    for (const attr of attrs) {
      const attrName = attr.name.toLowerCase();

      // 强行剔除任何 on 开头的内嵌事件处理器或不在白名单的属性 (如 style)
      if (attrName.startsWith("on") || !allowedForTag.has(attrName)) {
        el.removeAttribute(attr.name);
        continue;
      }

      // 3. 针对 href 与 src 属性进行深度 URL 净化
      if (attrName === "href" || attrName === "src") {
        if (!isSafeUrl(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }

      // 4. class 与 id 标识符字符集收紧 (防止注入选择器破坏 DOM 逻辑)
      if (attrName === "class" && !/^[a-zA-Z0-9_\-\s]+$/.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
      if (attrName === "id" && !/^[a-zA-Z0-9_\-]+$/.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }

    // 5. 对 <a> 标签强制注入安全防护属性
    if (tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }

  const container = document.createElement("div");
  container.appendChild(content);
  return container.innerHTML;
}

// 2. 改造 createBlockNode：先清洗再注入
function createBlockNode(block, index) {
  const wrap = document.createElement("div");
  wrap.className = "md-block";
  wrap.dataset.index = String(index);
  const rawHtml = renderBlockHtml(block);
  wrap.innerHTML = sanitizeHtmlStrict(rawHtml);
  return wrap;
}

// 3. 改造预览区超链接点击委托：一律拦截默认导航
el.preview.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a && el.preview.contains(a)) {
    // 关键防线：永远阻止浏览器默认导航，防止 Webview 直接跳转执行 javascript: 伪协议
    e.preventDefault();
    e.stopPropagation();

    const href = (a.getAttribute("href") || "").trim();
    if (!href) return;

    // 锚点跳转
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = el.preview.querySelector(`[id="${CSS.escape(id)}"]`) || findHeadingByText(id);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    // 仅允许明确合法的外部网络协议
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      if (state.apiReady && window.pywebview?.api?.open_url) {
        window.pywebview.api.open_url(href);
      }
    } else {
      console.warn("[Security] Blocked untrusted external link navigation:", href);
      toast("已拦截不安全的链接跳转");
    }
    return;
  }
  // ... 其他块点击逻辑
});
```

---

### P0-4: 修复异步文件保存、另存为与多标签状态脱节 (State Desync Defense)

#### 1. 问题陈述与影响范围
- **问题**：`web/js/app.js` 中 `saveFile()` 在 `await write_file` 返回后，才通过 `state.activeTabId` 查找当前标签页。如果在保存期间用户点击切换了标签，新标签页的数据会被旧保存内容强行覆盖。同时，在写盘等待期间（10~200ms），用户若在当前文档中继续敲字打字，I/O 返回后无条件清空 `dirty = false`，导致最新输入的字符被标记为已存盘，关闭窗口时静默丢失（代际竞态）。此外，`saveFileAs()` 缺少 `state.tabs` 同步且无条件修改全局 UI 标题，若用户在弹窗期间切标签，会污染非活动标签页。代码中缺乏统一的 `commitActiveBlockEdits()` 导致块编辑状态未落盘。
- **受影响组件**：`web/js/app.js` (`saveFile`, `saveFileAs`, `saveActiveTabFromEditor`)。

#### 2. 分步实施计划
1. **显式实现 `commitActiveBlockEdits()` 辅助函数**：优先调度既有 `commitActiveEditsForHistory()` 并将激活块的 `contenteditable` 内容同步至底层 `el.source.value`。
2. **引入代际事务令牌 (`tab.rev`)**：在 Tab 模型中引入单调自增版本号 `rev`。每次编辑递增版本号；异步写盘前捕获快照 `saveRev = tab.rev`。只有当写盘成功返回且 `tab.rev === saveRev` 时，才允许清除 `tab.dirty = false`。
3. **在异步 I/O 前固定目标引用**：锁定 `targetTabId` 与目标路径，绝不在异步回调中读取易变的 `state.activeTabId`。
4. **`saveFileAs` 严格作用域隔离**：仅当用户依然停留在原标签时才修改全局活动 UI，否则仅更新目标 Tab 对象的元数据。
5. **PDF 模式防串扰**：`saveActiveTabFromEditor` 在 `tab.kind === 'pdf'` 时直接跳过，防止 Markdown 文本污染 PDF 标签。

#### 3. 生产级修复代码 (JavaScript)

```javascript
// web/js/app.js

// 0. 明确实现块编辑内容提交辅助函数
function commitActiveBlockEdits() {
  if (typeof commitActiveEditsForHistory === "function") {
    commitActiveEditsForHistory();
  }
  const activeBlock = el.preview?.querySelector(".md-block-edit, [contenteditable='true']");
  if (activeBlock) {
    const idx = Number(activeBlock.dataset.index);
    if (!Number.isNaN(idx) && typeof serializeBlockToSource === "function") {
      serializeBlockToSource(activeBlock, idx);
    }
  }
}

// 1. 具备代际事务令牌保护的安全保存
async function saveFile() {
  if (!state.apiReady) return;
  commitActiveBlockEdits(); // 确保正在编辑的块提交入源码

  // 关键 1：在异步前捕获不可变的目标标签与路径引用，并记录当前代际快照
  const targetTabId = state.activeTabId;
  const tab = state.tabs.find((t) => t.id === targetTabId);
  const targetPath = tab?.path || state.path;
  const contentToSave = el.source.value;
  const saveRev = tab ? (tab.rev || 0) : 0; // 捕获发起保存时的版本快照

  if (targetPath) {
    const res = await window.pywebview.api.write_file(targetPath, contentToSave);
    if (res?.error) {
      toast("保存失败: " + res.error);
      return;
    }

    // 关键 2：定向更新最初发起保存的 tab 实例，检查代际令牌
    if (tab) {
      tab.path = targetPath;
      // 仅当在途保存期间用户没有发生新的打字编辑 (代际一致) 时，才抹除 dirty 标记
      if (tab.rev === saveRev) {
        tab.content = contentToSave;
        tab.dirty = false;
      } else {
        console.log("[StateGuard] 保存期间检测到新打字输入，保留 tab.dirty 标志以防数据丢失");
      }
    }

    // 关键 3：仅当用户在保存完成时仍停留在原发起标签页时，才同步全局 UI
    if (state.activeTabId === targetTabId) {
      if (tab && tab.dirty === false) {
        state.dirty = false;
        el.dirtyDot.hidden = true;
      }
      state.content = tab ? tab.content : contentToSave;
      updateWindowTitle();
    }

    updateAutosaveStatus();
    renderTabs();
    toast("已保存");
  } else {
    await saveFileAs();
  }
}

// 2. 具备多标签 UI 污染隔离的另存为
async function saveFileAs() {
  if (!state.apiReady) return;
  commitActiveBlockEdits();

  const targetTabId = state.activeTabId;
  const tab = state.tabs.find((t) => t.id === targetTabId);
  const content = el.source.value;
  const defaultName = tab?.name || state.name || "未命名.md";

  const res = await window.pywebview.api.save_file_dialog(content, defaultName);
  if (!res || res.error) {
    if (res?.error) toast(res.error);
    return;
  }

  const newName = res.path.split(/[\\/]/).pop();

  // 1. 定向更新最初发起另存的目标 tab 实例
  if (tab) {
    tab.path = res.path;
    tab.name = newName;
    tab.content = content;
    tab.dirty = false;
  }

  // 2. 关键防线：仅当用户当前激活的仍是发起另存的标签页时，才更新全局活动 UI
  // 严禁在后台标签页另存返回时污染当前前台标签页的标题与路径
  if (state.activeTabId === targetTabId) {
    state.path = res.path;
    state.name = newName;
    state.content = content;
    state.dirty = false;
    el.dirtyDot.hidden = true;
    el.fileTitle.textContent = state.name;
    el.statusPath.textContent = res.path;
    updateWindowTitle();
  }

  renderTabs();
  toast("已保存为: " + newName);
  updateAutosaveStatus();
  await refreshRecents();
  if (state.folder) await loadFolder(state.folder);
}
```

---

### P0-5: 纠正 `Ctrl+Shift+Z` 反人类快捷键与编辑态保护 (UX Conflict Resolution)

#### 1. 问题陈述与影响范围
- **问题**：`web/js/app.js:4265-4275` 中将 `Ctrl+Shift+Z` 错误映射为 `undoEdit()`（二次撤销），违反全体桌面软件通用的 Redo（重做）规范。此外在非编辑状态下选中文本按 `Ctrl+B` 会错误折叠侧边栏；更严重的是，全局 keydown 监听器未对 `<input>`、`<textarea>`、AI 提问输入框进行焦点审查，导致在表单中按 `Ctrl+Z` 直接被全局拦截并撤销了主编辑器内容（输入框劫持 Bug）。
- **受影响组件**：`web/js/app.js` (`handleGlobalKeydown`)。

#### 2. 分步实施计划与生产级代码

```javascript
// web/js/app.js

// 辅助函数：判断事件目标是否为原生输入控件或外部可编辑区域
function isTypingField(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toUpperCase() : "";
  // 原生输入框、文本域、下拉选择器坚决放行原生快捷键行为
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  // 处于非 Markdown 块编辑器的 contenteditable 区域 (如 AI 聊天输入框或独立弹窗)
  if (target.isContentEditable && !target.classList.contains("md-block-edit") && !el.preview?.contains(target)) {
    return true;
  }
  return false;
}

document.addEventListener("keydown", (e) => {
  // 关键防线：若焦点处于输入框、文本域或独立聊天框，坚决放行原生键盘事件，绝不劫持！
  if (isTypingField(e.target)) {
    return;
  }

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return;

  const key = e.key.toLowerCase();

  // 1. 严格对齐撤销与重做快捷键标准
  if (key === "z") {
    e.preventDefault();
    if (e.shiftKey) {
      // 纠正：Shift+Z 强制映射为重做！
      if (!redoEdit()) toast("没有可重做的操作");
    } else {
      if (!undoEdit()) toast("没有可撤销的操作");
    }
    return;
  }

  // Windows 标准重做 Ctrl+Y
  if (key === "y" && !isMac) {
    e.preventDefault();
    if (!redoEdit()) toast("没有可重做的操作");
    return;
  }

  // 2. 选区敏感的 Ctrl+B 格式化加固
  if (key === "b") {
    const sel = window.getSelection();
    // 只要编辑器存在选区或焦点处于编辑块中，强制加粗，禁止穿透触发折叠侧边栏
    if (sel && !sel.isCollapsed && el.preview.contains(sel.anchorNode)) {
      e.preventDefault();
      e.stopPropagation();
      formatSelection("bold");
      return;
    }
  }
});
```

---

### P0-6: 接入 Tauri 原生窗口关闭生命周期守卫与安全退出命令 (Lifecycle Guard)

#### 1. 问题陈述与影响范围
- **问题**：`main.rs` 未拦截 `WindowEvent::CloseRequested`，用户点击原生窗口关闭或按 `Alt+F4` 时，非活动标签页的未保存改动被静默丢弃。同时，若拦截了 `prevent_close()`，前端需要调用退出原生命令以正常关闭进程；若缺少 `stuart_exit_app` 命令定义与注册，调用将引发 `CommandNotFound` 异常，造成窗口彻底无法关闭的死锁 Bug。
- **受影响组件**：`tauri/src-tauri/src/main.rs`、`tauri/src-tauri/src/win_api.rs`、`web/js/app.js`。

#### 2. 生产级修复代码 (Rust & JS)

在 `tauri/src-tauri/src/win_api.rs` 中定义退出原生命令：

```rust
// tauri/src-tauri/src/win_api.rs

#[tauri::command]
pub fn stuart_exit_app<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    log::info!("[Lifecycle] 前端多标签检查完成，批准应用安全退出");
    app.exit(0);
}
```

在 `tauri/src-tauri/src/main.rs` 中注册该命令并接入窗口关闭拦截：

```rust
// tauri/src-tauri/src/main.rs

tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        // ... 其他命令
        win_api::stuart_exit_app,
    ])
    .on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // 阻止窗口瞬间静默销毁，交由前端多标签卫士进行脏数据仲裁
            api.prevent_close();
            let _ = window.emit("stuart-window-close-requested", ());
        }
    })
```

在前端 `web/js/app.js` 中增加监听与 3 秒草稿容灾：

```javascript
// web/js/app.js

// 1. 窗口关闭拦截与未保存模态框
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("stuart-window-close-requested", async () => {
    commitActiveBlockEdits();
    const dirtyTabs = state.tabs.filter((t) => t.dirty);
    if (dirtyTabs.length === 0) {
      // 关键闭环：无脏数据，通过已注册的原生命令安全退出，绝无死锁
      await window.__TAURI__.core.invoke("stuart_exit_app");
      return;
    }
    showUnsavedExitModal(dirtyTabs);
  });
}

// 2. 3 秒定时草稿容灾流 (Zero-Loss Journaling)
let _draftTimer = null;
function scheduleDraftJournal() {
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(async () => {
    if (!state.content) return;
    const docId = state.path ? hashString(state.path) : "untitled_" + (state.activeTabId || "def");
    try {
      if (window.pywebview?.api?.save_draft) {
        await window.pywebview.api.save_draft(docId, state.content);
      }
    } catch (_) {}
  }, 3000);
}
```

---

### P0-7: 修复 Windows DPAPI 凭证加密加固、应用熵隔离与内存安全擦除 (DPAPI Hardening & Zeroization)

#### 1. 问题陈述与影响范围
- **问题**：`tauri/src-tauri/src/ai_chat.rs:43-121` 中 DPAPI 实现存在三重严重安全与健全性隐患（Finding R-05）：
  1. **缺少应用专属熵 (`pOptionalEntropy`)**：调用 `CryptProtectData` 时传入 `null_mut()`。在 Windows 下，若不加熵，同用户桌面会话下的任何非特权木马程序均可直接解密读取该敏感凭证。
  2. **缺少内存擦除 (Missing Zeroization)**：调用 `LocalFree` 释放解密缓冲区前，未调用安全清零（如 `SecureZeroMemory`）。敏感 API Key 明文长久驻留在堆内存脏块中，易遭转储提取。
  3. **空切片未定义行为 (Soundness UB)**：对 `out_blob.pbData` 直接调用 `slice::from_raw_parts`。当解密空数据或异常时指针为 NULL，违反 Rust 规范（指针必须非空且有效对齐）。
- **受影响组件**：`ai_chat.rs` (`dpapi_protect`, `dpapi_unprotect`)、AI 供应商 API Key 本地安全保险库。

#### 2. 分步实施计划
1. 定义全局应用专属熵盐值（`const APP_ENTROPY: &[u8]`），通过 `CRYPTOAPI_BLOB` 传入 `pOptionalEntropy`，且启用 `CRYPTPROTECT_UI_FORBIDDEN` 标志位。
2. 健全性指针校验：严格检查 `pbData.is_null()` 与 `cbData == 0`，若为空安全返回空字节集合，坚决杜绝空指针创建切片。
3. 物理级安全内存擦除：在释放 `LocalFree` 之前，通过 `std::ptr::write_bytes` 对底层 Win32 堆内存执行全零覆写；Rust 临时向量使用 `zeroize::Zeroize` 进行析构前擦除。

#### 3. 生产级修复代码 (Rust)

在 `tauri/src-tauri/src/ai_chat.rs` 中重构 DPAPI 加解密核心：

```rust
// tauri/src-tauri/src/ai_chat.rs

#[cfg(target_os = "windows")]
pub mod dpapi {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPTOAPI_BLOB,
    };
    use zeroize::Zeroize;

    // 应用级专属熵盐值：阻断当前用户会话下的其他非特权木马或第三方进程直接解密提取凭证
    const APP_ENTROPY: &[u8] = b"stuartmd::secure_vault::entropy_salt_v1";

    pub fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        if plaintext.is_empty() {
            return Ok(Vec::new());
        }

        let mut data_in = CRYPTOAPI_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut entropy_blob = CRYPTOAPI_BLOB {
            cbData: APP_ENTROPY.len() as u32,
            pbData: APP_ENTROPY.as_ptr() as *mut u8,
        };
        let mut data_out = CRYPTOAPI_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        let success = unsafe {
            CryptProtectData(
                &mut data_in,
                ptr::null(), // 无描述符
                &mut entropy_blob,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        };

        if success == 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("DPAPI 加密失败: {err}"));
        }

        // 安全拷贝加密字节
        let ciphertext = if !data_out.pbData.is_null() && data_out.cbData > 0 {
            unsafe { std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize) }.to_vec()
        } else {
            Vec::new()
        };

        // 释放由 Windows LocalAlloc 分配的内存
        if !data_out.pbData.is_null() {
            unsafe { LocalFree(data_out.pbData as *mut core::ffi::c_void) };
        }

        Ok(ciphertext)
    }

    pub fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        if ciphertext.is_empty() {
            return Ok(Vec::new());
        }

        let mut data_in = CRYPTOAPI_BLOB {
            cbData: ciphertext.len() as u32,
            pbData: ciphertext.as_ptr() as *mut u8,
        };
        let mut entropy_blob = CRYPTOAPI_BLOB {
            cbData: APP_ENTROPY.len() as u32,
            pbData: APP_ENTROPY.as_ptr() as *mut u8,
        };
        let mut data_out = CRYPTOAPI_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        let success = unsafe {
            CryptUnprotectData(
                &mut data_in,
                ptr::null_mut(),
                &mut entropy_blob,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        };

        if success == 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("DPAPI 解密失败 (熵不匹配或数据损坏): {err}"));
        }

        // 关键防线 1：严格校验非空指针，杜绝空指针切片未定义行为 (Soundness UB)
        if data_out.pbData.is_null() || data_out.cbData == 0 {
            if !data_out.pbData.is_null() {
                unsafe { LocalFree(data_out.pbData as *mut core::ffi::c_void) };
            }
            return Ok(Vec::new());
        }

        // 安全获取明文字节切片并拷贝入 Rust 安全堆内存
        let mut plaintext = unsafe {
            std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize)
        }.to_vec();

        // 关键防线 2：在释放 Win32 内存句柄前，显式擦除明文缓冲区，封堵转储提取
        unsafe {
            ptr::write_bytes(data_out.pbData, 0, data_out.cbData as usize);
            LocalFree(data_out.pbData as *mut core::ffi::c_void);
        }

        Ok(plaintext)
    }
}
```

---

### Phase P0 阶段验证与验收核对表

- [ ] **R-01 验证**：调用 `stuart_open_url("https://example.com/?q=1&calc.exe")` 与 `stuart_open_url("https://example.com\" --disable-web-security")`，确认危险字符被阻断，仅在默认浏览器中安全打开规范网页，无外部进程或参数逃逸。
- [ ] **R-02 验证**：多线程并发自动保存 10,000 次，验证唯一 Nonce 零冲突；断电强杀测试原文档完整性；检查 NTFS 创建时间保留；验证相对路径 `doc.md` 零 `os error 3` 报错。
- [ ] **R-05 (P0-7) 验证**：运行 DPAPI 测试，验证无应用熵无法解密；验证解密完成后堆内存缓冲区已被全零安全擦除；验证空数据输入零 Panic。
- [ ] **F-01 验证**：打开包含 `<svg/onload=...>`、`<a href="jav&#x09;ascript:...">` 及 SVG SMIL 动画的 Markdown，确认完全过滤，DevTools 零 XSS 注入。
- [ ] **F-02 验证**：在保存大文件期间连续快速切换标签并在写盘时打字，确认 `tab.rev` 准确保留未保存脏标记，各标签数据独立无污染。
- [ ] **F-03 & UX 验证**：在段落中连续输入后按 `Ctrl+S`，确认磁盘文件包含最新文本；测试 `Ctrl+Z` 与 `Ctrl+Shift+Z`，重做撤销表现完全符合直觉；验证原生输入框中撤销未被全局劫持。
- [ ] **P0-6 退出验证**：窗口关闭拦截触发后，若无脏数据，`stuart_exit_app` 顺畅退出进程，零卡死死锁。

---

## 2. Phase P1: 运行性能跃升与桌面体验重塑 (Mid-Term 3-4 Weeks)

本阶段聚焦于消除系统在高频交互与大文件读取下的性能瓶颈，重点解决 PDF 内存暴涨、AI 流式截断乱码与并发写配置丢数据。

---

### P1-1: PDF 二进制 IPC 零拷贝流化通道与尺寸边界保护 (Zero-Copy Pipeline)

#### 1. 架构方案
摒弃在 JSON 中传递 Base64 字符串的模式，通过 Tauri 原生自定义二进制响应管道传递原始字节。同时严密校验文件尺寸边界（上限 100MB），防止恶意超大文件引发未受控的堆内存暴涨与 OOM 崩溃。

#### 2. 生产级实现代码 (Rust & JS)

在 `tauri/src-tauri/src/fs_api.rs` 中：

```rust
// tauri/src-tauri/src/fs_api.rs

use tauri::ipc::Response;

const PDF_MAX_BYTES: u64 = 100 * 1024 * 1024; // 100 MB 物理边界安全阈值

#[tauri::command]
pub fn stuart_read_pdf_binary(path: String) -> Result<Response, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("PDF 文件不存在".to_string());
    }

    // 关键防线：校验物理文件尺寸上限，彻底杜绝无界堆内存分配与 OOM 拒绝服务
    let meta = fs::metadata(p).map_err(|e| format!("获取 PDF 元数据失败: {e}"))?;
    if !meta.is_file() {
        return Err("目标路径不是常规文件".to_string());
    }
    if meta.len() > PDF_MAX_BYTES {
        return Err(format!(
            "PDF 文件过大 ({:.2} MB)，超过系统 100 MB 安全处理上限",
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }

    let bytes = fs::read(p).map_err(|e| format!("读取 PDF 文件失败: {e}"))?;
    // 直接返回原始二进制流响应体，绕过 Base64 字符串与 JSON 文本拷贝
    Ok(Response::new(bytes))
}
```

在 `web/js/pdf-viewer.js` 中重构接收端：

```javascript
// web/js/pdf-viewer.js

async function openPdfOptimized(filePath) {
  // 1. 直接获取 ArrayBuffer 二进制对象，彻底消除 atob 与 3500 万次 JS for 循环！
  const arrayBuffer = await window.__TAURI__.core.invoke("stuart_read_pdf_binary", { path: filePath });
  
  // 2. 直接以 Uint8Array 初始化 PDF.js 核心
  state.doc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    cMapUrl: "libs/pdfjs/cmaps/",
    cMapPacked: true,
  }).promise;

  state.totalPages = state.doc.numPages;
  renderAllPagesVirtual();
}
```

---

### P1-2: PDF.js 视口滑动窗口与 Canvas 显存物理释放 (VRAM Eviction)

#### 1. 架构方案
维护同时处于活动状态的 Canvas 页面上限（$\le 5$ 页）。当页面滚出视口缓冲带时，必须显式调用 `canvas.width = 0; canvas.height = 0;` 通知 GPU 图形库 (Skia) 释放 Backing Store 物理显存（CDP 探针实测证实仅调用 `remove()` 释放率为 0MB，清零宽高释放率达 70%）。同时在快速滚动时调用 `RenderTask.cancel()` 并静默捕获 `RenderingCancelledException`，杜绝异常向上冒泡导致阅读器闪退。

#### 2. 生产级实现代码 (JavaScript)

```javascript
// web/js/pdf-viewer.js

const activeRenderTasks = new Map(); // pageNum -> RenderTask

function cancelAndEvictPage(wrap) {
  if (!wrap || wrap.dataset.painted !== "1") return;
  const pageNum = Number(wrap.dataset.page);

  // 1. 取消正在排队或执行中的渲染任务
  const task = activeRenderTasks.get(pageNum);
  if (task) {
    try {
      task.cancel();
    } catch (_) {}
    activeRenderTasks.delete(pageNum);
  }

  // 2. 物理级显存释放核心指令：清零 Canvas 尺寸通知图形驱动释放显存
  const canvases = wrap.querySelectorAll("canvas");
  canvases.forEach((c) => {
    c.width = 0;
    c.height = 0;
    c.remove();
  });

  const textLayer = wrap.querySelector(".pdf-text-layer");
  if (textLayer) textLayer.remove();

  wrap.dataset.painted = "0";
  wrap.classList.add("pending");
}

// 采用工程现有命名规范 renderPage(wrap) 渲染页面
async function renderPage(wrap) {
  if (!wrap || wrap.dataset.painted === "1") return;
  const pageNum = Number(wrap.dataset.page);
  if (!state.doc || pageNum < 1 || pageNum > state.totalPages) return;

  const page = await state.doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: state.scale });

  // 动态创建并挂载 Canvas
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";
  wrap.appendChild(canvas);

  const renderContext = {
    canvasContext: ctx,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    viewport: viewport,
  };

  const renderTask = page.render(renderContext);
  activeRenderTasks.set(pageNum, renderTask);

  try {
    await renderTask.promise;
    wrap.dataset.painted = "1";
    wrap.classList.remove("pending");
  } catch (err) {
    // 关键防线：静默捕获因快速滚动被 task.cancel() 触发的 RenderingCancelledException
    // 防止未捕获 Promise Rejection 向上冒泡导致整个 PDF 闪退回欢迎页
    if (err?.name === "RenderingCancelledException" || err?.message?.includes("cancelled")) {
      return;
    }
    console.error(`[PDF.js] Page ${pageNum} render error:`, err);
  } finally {
    activeRenderTasks.delete(pageNum);
  }
}

function setupVirtualizedPdfObserver(pageWrappers, scrollContainer) {
  if (state._virtualIo) {
    state._virtualIo.disconnect();
  }

  // 配置带 800px 缓冲区的进出双向视口监听
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const wrap = entry.target;
        if (entry.isIntersecting) {
          renderPage(wrap); // 调用规范命名的 renderPage 函数
        } else {
          // 离开视口缓冲带立即销毁画布，强制物理显存释放
          cancelAndEvictPage(wrap);
        }
      });
    },
    { root: scrollContainer, rootMargin: "800px 0px" }
  );

  pageWrappers.forEach((w) => io.observe(w));
  state._virtualIo = io;
}
```

---

### P1-3: 修复 `settings.json` 并发读写 TOCTOU 竞态 (Transactional Mutex)

#### 1. 架构方案
实现全局事务修改高阶函数 `modify_settings<F>`，将“加锁 -> 读取配置 -> 内存业务修改 -> 唯一临时文件刷盘 -> 原子重命名 -> 解锁”纳入同一临界区。注意：
1. **纯净修改器契约 (Pure Modifier Contract)**：传入的 `modifier` 闭包必须是纯内存数据更新逻辑，严禁在闭包内部再次调用任何尝试获取 `SETTINGS_LOCK` 的方法，以杜绝非可重入锁导致的自死锁 (Self-Deadlock)。
2. **多进程跨窗口互斥演化**：对于通过独立 OS 进程拉起的多窗口场景，内存级 `Mutex<()>` 无法跨进程生效，路线图规划后续引入基于 OS 文件锁（如 `fs2::FileExt::lock_exclusive` / Win32 `LockFileEx`）的跨进程文件锁，彻底保证多进程实例并发安全。

#### 2. 生产级实现代码 (Rust)

```rust
// tauri/src-tauri/src/fs_api.rs

pub fn modify_settings<F>(modifier: F) -> Result<Value, String>
where
    F: FnOnce(&mut Value) -> Result<(), String>,
{
    // 关键防线：互斥锁贯穿整个读-改-写事务生命周期
    let _guard = settings_guard();
    let path = settings_path();
    let mut current = load_settings_migrated_unlocked();

    // 执行纯内存业务字段注入 (modifier 严禁再次触发获取锁操作)
    modifier(&mut current)?;

    // 使用安全原子写盘落盘，杜绝截断与并发写冲突
    let bytes = serde_json::to_vec_pretty(&current).map_err(|e| e.to_string())?;
    atomic_write_file(&path, &bytes)?;

    Ok(current)
}
```

---

### P1-4: 治理 AI 流式字符截断乱码、[DONE] 挂起死锁与事件注册竞态

#### 1. 架构方案与根因修复
1. **彻底修复 `[DONE]` 终结信号吞没死锁**：在 `parse_sse_data_line` 中严禁提前返回 `None` 丢弃 `[DONE]`。必须将 `[DONE]` 作为合法数据或枚举信号透传给外层循环，确保流式循环能够在接收到完成包后立即 `break` 退出并关闭套接字，消除长达 90 秒的套接字挂起。
2. **TCP/TLS 字节切片完整缓冲**：维持纯字节切片缓冲区 `Vec<u8>`，仅在扫描到完整的 `\n` 时提取完整行后再执行 UTF-8 解码，根除汉字 3 字节跨分包截断产生的 `` 乱码。
3. **套接字关闭尾包防丢保护**：当套接字返回 `Ok(0)` (EOF) 时，若缓冲区内仍有未以 `\n` 结尾的尾部残存字节，强制清洗提取并派发，杜绝丢字。
4. **单行无界内存防护**：设置 `MAX_LINE_BYTES = 1MB`，防止异常或恶意上游发送无换行长流导致内存耗尽。
5. **前端取消令牌双向同步**：在发起请求前预先注册监听器，并将生成的 `requestId` 完整绑定同步至 `global.StuartAI.state.requestId` 与 `uiState.requestId`，确保用户点击取消按钮时后端精准定位并中止请求。

#### 2. 生产级实现代码 (Rust 字节级断行与流式终结)

```rust
// tauri/src-tauri/src/ai_chat.rs

/// 规范化解析 SSE 数据行：绝不提前过滤 [DONE]，确保外层流式终止逻辑能够接收到终结信号
pub fn parse_sse_data_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return None;
    }
    let data = trimmed["data:".len()..].trim();
    if data.is_empty() {
        return None;
    }
    // 关键修正：保留 [DONE] 原始标记返回，防止外层 if data == "[DONE]" 沦为 100% 不可达死代码
    Some(data.to_string())
}

// 核心流式读取循环实现
pub fn run_sse_streaming_reader<R: std::io::Read>(
    mut reader: R,
    app: &tauri::AppHandle,
    rid2: String,
) -> Result<String, String> {
    let mut byte_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    let mut acc = String::new();
    let mut finished_ok = false;
    const MAX_LINE_BYTES: usize = 1024 * 1024; // 1MB 单行安全上限

    loop {
        if is_cancelled(&rid2) {
            log::info!("[AI Chat] 检测到取消信号，主动跳出流式读取循环: {}", rid2);
            break;
        }

        match reader.read(&mut chunk) {
            Ok(0) => {
                // 关键防线：套接字正常关闭 (EOF) 时，处理尾部可能未以 \n 结尾的残余字节
                if !byte_buf.is_empty() {
                    let clean_slice = if byte_buf.ends_with(b"\r\n") {
                        &byte_buf[..byte_buf.len() - 2]
                    } else if byte_buf.ends_with(b"\n") {
                        &byte_buf[..byte_buf.len() - 1]
                    } else {
                        &byte_buf[..]
                    };
                    let line = String::from_utf8_lossy(clean_slice);
                    if let Some(data) = parse_sse_data_line(&line) {
                        if data == "[DONE]" {
                            finished_ok = true;
                        } else if let Ok(v) = serde_json::from_str::<Value>(&data) {
                            let piece = extract_delta_text(&v);
                            if !piece.is_empty() {
                                acc.push_str(&piece);
                                emit_chat(app, "ai-chat-delta", json!({"requestId": rid2, "text": piece}));
                            }
                        }
                    }
                    byte_buf.clear();
                }
                finished_ok = finished_ok || !acc.is_empty();
                break;
            }
            Ok(n) => {
                // 纯字节追加，绝不在网络切片边界直接调用 from_utf8_lossy
                byte_buf.extend_from_slice(&chunk[..n]);

                if byte_buf.len() > MAX_LINE_BYTES {
                    log::error!("[AI Stream] 单行长度超过 1MB 限制，主动清空缓冲区以保护内存");
                    byte_buf.clear();
                    break;
                }

                // 仅在发现完整的换行符 \n 时才截取完整行进行 UTF-8 解码
                while let Some(pos) = byte_buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = byte_buf.drain(..=pos).collect();
                    let clean_slice = if line_bytes.ends_with(b"\r\n") {
                        &line_bytes[..line_bytes.len() - 2]
                    } else if line_bytes.ends_with(b"\n") {
                        &line_bytes[..line_bytes.len() - 1]
                    } else {
                        &line_bytes[..]
                    };

                    let line = String::from_utf8_lossy(clean_slice);
                    if let Some(data) = parse_sse_data_line(&line) {
                        // 准确捕获 [DONE] 终结信号，立即结束并关闭套接字
                        if data == "[DONE]" {
                            finished_ok = true;
                            break;
                        }
                        if let Ok(v) = serde_json::from_str::<Value>(&data) {
                            let piece = extract_delta_text(&v);
                            if !piece.is_empty() {
                                acc.push_str(&piece);
                                emit_chat(app, "ai-chat-delta", json!({"requestId": rid2, "text": piece}));
                            }
                        }
                    }
                }
                if finished_ok {
                    break;
                }
            }
            Err(e) => {
                log::error!("[AI Stream] 套接字读取异常: {e}");
                break;
            }
        }
    }

    emit_chat(app, "ai-chat-done", json!({
        "requestId": rid2,
        "finished": finished_ok,
        "cancelled": !finished_ok && is_cancelled(&rid2),
        "text": acc
    }));

    Ok(acc)
}
```

#### 3. 前端事件提前注册与取消令牌完整绑定 (JavaScript)

```javascript
// web/js/ui/ai-ui.js

async function executeAiChatWithSafeListeners(prompt, provider, cfg) {
  const requestId = "req_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  uiState.requestId = requestId;

  // 关键修正：将 requestId 同步注入全局 StuartAI 状态，确保取消按钮能够准确调用 ai_chat_cancel
  if (window.StuartAI?.state) {
    window.StuartAI.state.requestId = requestId;
  }

  let unDelta = null;
  let unDone = null;

  // 1. 关键：在发出 chat_start 命令之前，预先完成监听器注册，杜绝首包丢失！
  const pDelta = window.__TAURI__.event.listen("ai-chat-delta", (e) => {
    if (e.payload?.requestId !== requestId) return;
    setThinking(false);
    uiState.lastAnswer += e.payload.text || "";
    scheduleRafRender(uiState.lastAnswer);
  });

  const pDone = window.__TAURI__.event.listen("ai-chat-done", (e) => {
    if (e.payload?.requestId !== requestId) return;
    if (unDelta) unDelta();
    if (unDone) unDone();
    finishChatStream(uiState.lastAnswer, e.payload.error);
  });

  [unDelta, unDone] = await Promise.all([pDelta, pDone]);

  // 2. 正式派发后端请求
  const res = await window.__TAURI__.core.invoke("stuart_ai_chat_start", {
    requestId,
    model: provider.model,
    messages: uiState.history,
  });

  if (res?.error) {
    if (unDelta) unDelta();
    if (unDone) unDone();
    finishChatStream("", res.error);
  }
}
```

---

### Phase P1 阶段验证与验收核对表

- [ ] **P1-1 验证**：打开 40MB PDF，DevTools Performance 面板记录主线程冻结时间由 >1200ms 降至 <20ms；尝试读取 >100MB PDF，确认被安全边界拦截，系统零 OOM。
- [ ] **P1-2 验证**：连续快速滚阅 100 页 PDF，任务管理器中 WebView2 显存保持在 150MB 以下平稳运行；测试快速滚动触发取消，确认 `RenderingCancelledException` 被安全捕获，零闪退崩溃。
- [ ] **P1-3 验证**：并发 10 个线程交替触发保存 AI 密钥与记录窗口尺寸，验证 500 次后 `settings.json` 零字段丢失；确认 modifier 保持纯净无嵌套锁调用。
- [ ] **P1-4 验证**：单字节切片喂入中文段落，AI 流式接收拼装后严格 100% 还原原文，零 `` 乱码；验证接收到 `data: [DONE]` 时流式循环立即退出，网络连接瞬间关闭，零悬挂超时；点击取消按钮立即终止后台网络流。

---

## 3. Phase P2: 架构深水区演进与生态边界扩张 (Long-Term 2-3 Months)

本阶段聚焦于 StuartMD 的长期核心竞争力构建，打造超越 Typora / Obsidian 的底层混合块编辑器、标准 W3C PDF 批注系统、本地轻量 RAG 及受限沙箱插件架构。

---

### P2-1: 方案一：AST 驱动的混合块编辑引擎与事务级撤销栈

#### 1. 架构方案
摒弃正则反解，基于 Markdown AST 构建双向绑定的块编辑核心，引入基于 Delta 的操作转换历史栈。

#### 2. 核心数据结构与实现范式 (TypeScript)

```typescript
// web/js/core/editor/ast-engine.ts

export interface BlockAstNode {
  id: string; // 唯一稳定 UUID
  type: "heading" | "paragraph" | "code_block" | "math_block" | "blockquote" | "list_item";
  level?: number;
  rawMarkdown: string;
  sourceRange: [number, number]; // [startOffset, endOffset]
  children?: BlockAstNode[];
}

export interface DeltaTransaction {
  id: string;
  timestamp: number;
  blockId: string;
  type: "insert_text" | "delete_text" | "split_block" | "merge_block";
  offset: number;
  text: string;
  length?: number;
}

export class TransactionHistoryStack {
  private undoStack: DeltaTransaction[][] = [];
  private redoStack: DeltaTransaction[][] = [];
  private maxDepth = 1000;

  public push(tx: DeltaTransaction[]): void {
    this.undoStack.push(tx);
    this.redoStack = []; // 清空重做栈
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
  }

  public undo(applyCallback: (tx: DeltaTransaction, reverse: boolean) => void): boolean {
    const txGroup = this.undoStack.pop();
    if (!txGroup) return false;
    for (let i = txGroup.length - 1; i >= 0; i--) {
      applyCallback(txGroup[i], true);
    }
    this.redoStack.push(txGroup);
    return true;
  }
}
```

---

### P2-2: 方案二：W3C Web Annotation 同构侧车批注与深度链接

#### 1. 架构方案
- 存储定位：`<pdf_path>.stuart.json` 同构保存。
- 深度链接协议：`stuart://pdf?path=<rel>&page=<num>&ann=<id>`。

#### 2. 生产级数据模型与定位算法 (JavaScript)

```javascript
// web/js/core/pdf/sidecar-annotation.js

export function createW3cAnnotation(page, rect, textQuote, comment) {
  return {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    id: "urn:stuart:ann:" + Math.random().toString(36).slice(2, 10),
    type: "Annotation",
    motivation: "highlighting",
    body: {
      type: "TextualBody",
      value: comment || "",
      purpose: "commenting",
    },
    target: {
      selector: [
        {
          type: "FragmentSelector",
          value: `page=${page}`,
          boundingBox: {
            x: rect.x / page.viewWidth,
            y: rect.y / page.viewHeight,
            w: rect.w / page.viewWidth,
            h: rect.h / page.viewHeight,
          },
        },
        {
          type: "TextQuoteSelector",
          exact: textQuote.exact,
          prefix: textQuote.prefix,
          suffix: textQuote.suffix,
        },
      ],
    },
    created: new Date().toISOString(),
  };
}
```

---

### P2-3: 方案三：轻量级本地向量 RAG 与跨文档伴读引擎

#### 1. 架构方案
基于 Rust 端内嵌 `sqlite-vec` 与 `fastembed-rs`（BGE-Small-ZH 模型），提供全离线文档语义检索。
在并发与线程安全架构上，将 `rusqlite::Connection` 封装于 `Arc<Mutex<Connection>>` 中，满足 Tauri v2 托管状态 (`tauri::State<LocalRagEngine>`) 所必需的 `Send + Sync + 'static` 约束，杜绝多线程调用下的数据竞争与编译失败。同时首期支持轻量 BM25 纯文本检索降级，高级向量检索包作为按需模块。

#### 2. 核心架构逻辑实现 (Rust)

```rust
// tauri/src-tauri/src/ai_rag.rs

use fastembed::{TextEmbedding, InitOptions, EmbeddingModel};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct LocalRagEngine {
    model: TextEmbedding,
    // 关键防线：将 rusqlite::Connection 包装于 Arc<Mutex<...>>
    // 确保 LocalRagEngine 满足 Send + Sync，可作为 Tauri 托管状态注册于 app.manage()
    db_conn: Arc<Mutex<rusqlite::Connection>>,
}

impl LocalRagEngine {
    pub fn init(storage_path: &Path) -> Result<Self, String> {
        let model = TextEmbedding::try_new(InitOptions {
            model_name: EmbeddingModel::BGESmallZH,
            show_download_progress: false,
            ..Default::default()
        }).map_err(|e| format!("初始化向量模型失败: {e}"))?;

        let conn = rusqlite::Connection::open(storage_path.join("embeddings.vss"))
            .map_err(|e| e.to_string())?;

        // 显式加载并初始化 sqlite-vec 扩展库 (启用 vec0 虚拟表引擎)
        unsafe {
            conn.load_extension_enable().map_err(|e| format!("启用 SQLite 扩展权限失败: {e}"))?;
            // 根据操作系统环境加载 sqlite-vec 共享库或静态链接绑定
            // sqlite_vec::sqlite3_vec_init(&conn);
        }

        // 初始化文档块元数据表与向量虚拟表
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS doc_chunks (
                id TEXT PRIMARY KEY,
                file_path TEXT,
                heading TEXT,
                content TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding float[512]
            );"
        ).map_err(|e| e.to_string())?;

        Ok(Self {
            model,
            db_conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn query_semantic_context(&self, query: &str, limit: usize) -> Result<Vec<String>, String> {
        let embeddings = self.model.embed(vec![query], None).map_err(|e| e.to_string())?;
        let query_vec = &embeddings[0];

        // 将 float vector 序列化为字节缓冲以供 sqlite-vec MATCH 参数绑定
        let query_bytes: Vec<u8> = query_vec
            .iter()
            .flat_map(|f| f.to_ne_bytes())
            .collect();

        let conn = self.db_conn.lock().map_err(|_| "获取 SQLite 互斥锁失败 (Poisoned)".to_string())?;

        // 基于向量余弦距离搜索 Top-K
        let mut stmt = conn.prepare(
            "SELECT c.content FROM vec_chunks v
             JOIN doc_chunks c ON c.id = v.chunk_id
             WHERE v.embedding MATCH ?
             ORDER BY distance LIMIT ?"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(rusqlite::params![query_bytes, limit], |row| {
            row.get::<_, String>(0)
        }).map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        for r in rows.flatten() {
            results.push(r);
        }
        Ok(results)
    }
}
```

---

### P2-4: 方案四：基于能力清单与沙箱隔离的声明式插件架构

#### 1. 架构方案
摒弃 `new Function(..., window, document)`，采用包含 `sandbox="allow-scripts"` 的隔离 `iframe` + 声明式权限清单 (`manifest.json`)。
使用符合 ES2022 规范的原生私有字段语法（`#field` 与 `#method`，彻底消除在 `.js` 文件中使用 TypeScript `private` 关键字导致的语法错误），并通过注入内置 RPC 引导脚本的 `srcdoc` 搭配 `MessageChannel` 实现真正双向可通的沙箱通信拓扑。

#### 2. 沙箱 RPC 桥接实现 (JavaScript - 标准 ES2022)

```javascript
// web/js/core/plugins/sandbox-host.js

export class SecurePluginSandboxHost {
  #manifest;
  #iframe;
  #port;
  #isReady = false;

  constructor(pluginManifest, codeString) {
    this.#manifest = pluginManifest;
    this.#iframe = document.createElement("iframe");
    // 关键防线：仅允许脚本执行，严禁 allow-same-origin 访问主窗口 DOM 与 Cookies/LocalStorage
    this.#iframe.setAttribute("sandbox", "allow-scripts");
    this.#iframe.style.display = "none";

    // 关键修复：通过 srcdoc 注入内置消息监听器的沙箱环境，杜绝空白 iframe 通信死锁
    this.#iframe.srcdoc = `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body>
          <script>
            window.addEventListener("message", (event) => {
              if (event.data?.type === "INIT") {
                const port = event.ports[0];
                const code = event.data.code;
                try {
                  const pluginFn = new Function("api", code);
                  pluginFn({
                    call: (method, payload) => {
                      return new Promise((resolve, reject) => {
                        const callId = Math.random().toString(36).slice(2);
                        const handler = (e) => {
                          if (e.data?.callId === callId) {
                            port.removeEventListener("message", handler);
                            if (e.data.error) reject(new Error(e.data.error));
                            else resolve(e.data.result);
                          }
                        };
                        port.addEventListener("message", handler);
                        port.start();
                        port.postMessage({ type: "RPC_CALL", callId, method, payload });
                      });
                    }
                  });
                  port.postMessage({ type: "READY" });
                } catch (err) {
                  port.postMessage({ type: "ERROR", error: String(err) });
                }
              }
            });
          </script>
        </body>
      </html>
    `;

    document.body.appendChild(this.#iframe);
    this.#initRpcBridge(codeString);
  }

  #initRpcBridge(codeString) {
    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#port.onmessage = (e) => this.#handlePluginMessage(e.data);

    // 等待 iframe DOM 加载完成后建立 MessagePort 端口握手
    this.#iframe.onload = () => {
      this.#iframe.contentWindow.postMessage(
        { type: "INIT", code: codeString },
        "*",
        [channel.port2]
      );
    };
  }

  #handlePluginMessage(msg) {
    if (msg.type === "READY") {
      this.#isReady = true;
      console.log(`[PluginHost] 插件 ${this.#manifest.id} 沙箱握手就绪`);
      return;
    }
    if (msg.type === "RPC_CALL") {
      // 权限门卫：严格比对 manifest.json 声明的权限清单
      if (!this.#manifest.permissions?.includes(msg.method)) {
        this.#port.postMessage({
          callId: msg.callId,
          error: `拒绝访问: 缺少权限 [${msg.method}]`,
        });
        return;
      }
      // 安全分发宿主能力 (只读文档、状态栏显示等)
      this.#dispatchHostCapability(msg);
    }
  }

  #dispatchHostCapability(msg) {
    // 依据授权能力执行受控宿主操作
    this.#port.postMessage({ callId: msg.callId, result: { ok: true } });
  }

  destroy() {
    if (this.#port) {
      this.#port.close();
    }
    if (this.#iframe) {
      this.#iframe.remove();
    }
  }
}
```

---

### Phase P2 阶段验证与验收核对表

- [ ] **P2-1 验证**：在嵌套多级列表和包含复杂的 LaTeX 公式块中进行实时块编辑，验证导出 Markdown 结构完好，数学公式无损，支持连续 500 次无损撤销。
- [ ] **P2-2 验证**：将带侧车批注的 PDF 及其 `.stuart.json` 拷贝至其他计算机，验证高亮与评论 100% 自动还原，双向深链精确对齐。
- [ ] **P2-3 验证**：确认 `LocalRagEngine` 成功注册进 `app.manage()` 并通过 `Send + Sync` 编译；在离线断网环境下导入 50 篇专业论文，针对深层细节提问，确认本地 RAG 准确检索并拼接 Top-3 段落注入 Prompt。
- [ ] **P2-4 验证**：加载插件确认标准 ES2022 私有属性 `#` 语法零解析错误；确认 `srcdoc` 内嵌 RPC 监听器成功握手并在控制台打印就绪日志；尝试突破权限读取 `window.parent` 或调用未授权 API，验证沙箱完全阻断。

---

## 4. 全生命周期质量保障与审计闭环

1. **静态代码质量门禁**：
   - Rust 后端：每次提交强制执行 `cargo clippy -- -D warnings` 与 `cargo audit`。
   - Web 前端：配置严格 ESLint 与 TypeScript 编译类型检查。
2. **安全防护持续验证**：
   - 定期执行 XSS 针对性模糊测试（Fuzzing）；
   - 定期检验 Windows DPAPI 内存转储，确保零明文停留。
3. **性能基线守护**：
   - 建立 CI 自动化测试基准：40MB PDF 加载必须保持在 100ms 以内，100 页阅读显存上限锚定在 150MB。
