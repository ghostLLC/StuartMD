# 音乐 / 白噪音播放 — 技术探索（未实现）

目标：阅读或专注时播放白噪音；内置几首「文雅」预设，并支持播放用户本地音频。

## 结论摘要

| 方案 | 可行性 | 体积 | 体验 | 建议 |
|------|--------|------|------|------|
| Web Audio 合成白噪音 | 高 | ≈0 | 即时、可控 | **默认首选** |
| 内置 wav/mp3 预设 | 高 | 中（每首 1–5MB） | 质感更好 | 少量精选 3–5 首 |
| 用户本地音频 | 高 | 0 | 灵活 | 文件对话框 + 路径记忆 |
| 外部流媒体 API | 低 | — | 版权/鉴权 | 不建议 |

现有栈：pywebview + WebView2，**浏览器 Audio API 完全可用**，无需再引入重型播放器框架。

## 推荐架构

```text
[设置 / 状态栏浮层]
   │
   ├─ 白噪音引擎（Web Audio）
   │    • 粉噪 / 棕噪 / 雨声近似（滤波噪声）
   │    • 音量、淡入淡出、循环
   │
   ├─ 预设库（可选打包）
   │    assets/audio/*.mp3  （或 OGG）
   │    内置：雨声、壁炉、咖啡馆、图书馆、风扇
   │
   └─ 用户文件
        open_audio_dialog() → 绝对路径
        file:// URI 或 Python 读入后 blob URL
```

### 1. 纯合成白噪音（零资源）

```js
const ctx = new AudioContext();
const bufferSize = 2 * ctx.sampleRate;
const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
const data = noiseBuffer.getChannelData(0);
for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
const src = ctx.createBufferSource();
src.buffer = noiseBuffer; src.loop = true;
const filter = ctx.createBiquadFilter(); // 低通 → 更「雨/风」
filter.type = "lowpass"; filter.frequency.value = 1200;
src.connect(filter).connect(ctx.destination);
src.start();
```

- 支持 **棕噪/粉噪**（积分或滤波）更耐听  
- 体积 0，启动快，可调 EQ  
- 「文雅」感靠低通 + 轻微 LFO，而不是生硬白噪  

### 2. 内置预设音频

- 打包进 `StuartMD` 的 `assets/audio/`（PyInstaller datas）  
- 建议 3–5 首短循环素材（30–120s loop），总大小控制在 **10–20MB**  
- 用 `<audio loop>` 或 `fetch` + `AudioBuffer`  
- 素材需可商用/CC0（如 Freesound 筛选，或自录制）  

### 3. 用户本地音频

```python
def open_audio_dialog(self) -> dict | None:
    # mp3 / wav / ogg / m4a / flac(视 WebView2)
    ...
    return {"path": ..., "uri": Path(path).as_uri()}
```

- `file://` 在 WebView2 中一般可播；若被拦，改为 Python 读 base64 → Blob  
- 设置里记住「上次播放列表」路径（文件不存在则忽略）  
- 支持多选：简单 playlist，顺序循环  

### 4. UI 草案

- 状态栏右侧：`♪` 图标 → 弹出迷你面板  
- 面板：播放/暂停、音量、预设列表、打开文件、淡入淡出开关  
- 快捷键建议：`Ctrl+Shift+M`（避免与文件/编辑冲突）  
- 设置持久化：`volume`、`lastTrack`、`loop`、`fade`  

### 5. 性能与占用

- AudioContext 常驻约 **几 MB 内存**，CPU 空闲时接近 0  
- 不要在未播放时 `setInterval` 采样；用 `ended` / `AudioParam`  
- 与文档渲染解耦，互不抢主线程  

### 6. 风险与边界

- 系统媒体键：WebView2 对 SMTC 支持有限，可后接原生钩子  
- DRM / 网易云等：不做，只做本地 + 内置素材  
- 大文件 flac：WebView2 兼容性一般，优先 mp3/wav  

## 建议落地顺序（待验收后再做）

1. **P0**：状态栏播放器 + 合成白噪音（雨/风/粉噪）+ 音量循环  
2. **P1**：用户打开本地音频 + 最近曲目  
3. **P2**：内置 3–5 首精选循环 + 更精致面板  
4. **P3**：淡入淡出、系统媒体键、播放列表  

## 跨窗口「拖成标签」补充说明

现状：标签可拖出新窗口；**整窗拖回成标签**未做。

原因：HTML5 DnD 只能拖 DOM 数据，**不能拖 HWND**；跨进程合并需要 IPC。

可行方案：

1. **代理路径**：拖出时写入临时文件 `%TEMP%\StuartMD-drag.json`（path）；目标窗口 `dragover` 时读取（需全局钩子，Windows 上 DnD 不跨进程自动触发目标 DOM）— 较难  
2. **命名管道 / localhost HTTP**：每实例监听 `127.0.0.1:随机口`，注册到 `%APPDATA%\StuartMD\instances.json`；目标窗口「合并」时 POST path 到对端 — **推荐可做**  
3. **托盘 / 快捷菜单「合并到主窗口」**：成本低，交互不如拖拽直觉  

建议先做 (2) 的简化版：右键标签 →「在其它窗口合并」列表，避免死磕原生 DnD。
