# StuartMD

轻量 Markdown 阅读与编辑器（Windows 桌面应用）。风格简约，适合日常读文档、写笔记、批注 PDF。

![version](https://img.shields.io/badge/version-1.6.3-blue)

## 功能

- Markdown：阅读 / 分栏 / 源码，点击段落直接编辑
- 快捷键：`Ctrl+B/I` 加粗斜体、`Ctrl+Alt+1..4` 标题、`Ctrl+Shift+7/8/9` 列表（类似飞书）
- 语法：表格、任务列表、代码高亮、LaTeX、Mermaid
- PDF：竖版横版阅读，标黄 / 擦除（批注存 AppData，不改原文件）
- 打开方式：智能新窗口 / 标签页；打开文件夹会在侧栏显示目录树
- 自动保存、多语言（简/繁/英）、主题与壁纸取色
- 插件：`%APPDATA%\StuartMD\plugins`，见 [docs/PLUGINS.md](docs/PLUGINS.md)

## 下载

从 [Releases](https://github.com/ghostLLC/StuartMD/releases) 下载 `StuartMD-Setup-*.exe`。

- 安装向导可自定义路径  
- 静默示例：`StuartMD-Setup-1.6.3.exe /VERYSILENT /DIR="D:\Apps\StuartMD"`

## 开发

依赖：Python 3.10+、pywebview、PyInstaller、Inno Setup 6（打包用）

```bash
pip install pywebview pyinstaller
python main.py          # 源码运行
build-installer.bat     # 打包 EXE + 安装包
```

## 配置位置

`%APPDATA%\StuartMD\`（settings.json、插件、壁纸、PDF 批注）

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

见仓库说明；默认个人/学习使用，请自行补充 LICENSE。
