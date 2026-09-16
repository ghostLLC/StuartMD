# StuartMD

轻量 Markdown 阅读与编辑器。打开、阅读、批注，保持专注。

**项目仓库：** [https://github.com/ghostLLC/StuartMD](https://github.com/ghostLLC/StuartMD)

**当前版本：** 1.4.2

---

## 能做什么

| 场景 | 说明 |
|------|------|
| 读文档 | 美化排版、公式、表格、代码高亮 |
| 写笔记 | 阅读 / 分栏 / 源码三种模式，自动保存 |
| 看 PDF | 竖版横版均可，支持标黄与擦除 |
| 多窗口 | 每个文档可独立开窗对照 |
| 换外观 | 浅色、深色、羊皮纸、小黄人、壁纸 |
| 多语言 | 简体中文、繁體中文、English |

## 快速开始

1. **文件** → 打开文件 / 打开文件夹  
2. 顶部切换 **阅读 · 分栏 · 源码**  
3. `Ctrl+S` 保存；有路径后会自动保存  
4. 设置里可改主题、语言、插件

## Markdown 示例

### 文本

*斜体*、**加粗**、~~删除线~~、`行内代码`

### 代码块

```javascript
console.log("Hello StuartMD");
```

### LaTeX

行内 $E = mc^2$

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

### 图表（Mermaid）

```mermaid
flowchart LR
  A[打开文档] --> B[阅读预览]
  B --> C[编辑批注]
  C --> D[自动保存]
```

### 任务列表

- [x] 安装并打开 StuartMD
- [ ] 试一下 PDF 标黄
- [ ] 换一个喜欢的主题

## PDF

- 打开 `.pdf` 即可阅读  
- 点 **标黄** 后选中文字即可高亮  
- **擦除** 模式下点高亮可删除  
- 横版自动适配，可旋转 / 适应宽高  

## 外观与壁纸

设置 → 外观：

- 浅色 / 深色 / 羊皮纸（阅读向）  
- 小黄人 / 毛玻璃（个性向）  
- **上传壁纸**：自动提取主色作为强调色  

## 插件

将 `.js` 插件放入：

`%APPDATA%\StuartMD\plugins\`

重启后生效。开发说明见安装目录下 `docs\PLUGINS.md`。

## 常用快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+N` | 新建文档 |
| `Ctrl+F` | 查找 |
| `Ctrl+E` | 导出 HTML |
| `Ctrl+P` | 打印 / PDF |
| `Ctrl+T` | 切换主题 |
| `Ctrl+1/2/3` | 阅读 / 分栏 / 源码 |
| `Ctrl+B` / `Ctrl+I` | 加粗 / 斜体（编辑中） |
| `Ctrl+Shift+X` | 删除线 |
| `Ctrl+Alt+1..4` | 一至四级标题 |
| `Ctrl+Shift+7` / `8` | 有序 / 无序列表 |
| `Ctrl+Shift+9` | 任务列表 |
| `Ctrl+B`（未编辑时） | 侧边栏 |

---

## 安装说明

- 安装向导可**自定义安装路径**（默认 `%LOCALAPPDATA%\Programs\StuartMD`，也可改到任意目录）
- 静默安装示例：`StuartMD-Setup-1.4.2.exe /VERYSILENT /DIR="D:\Apps\StuartMD"`
- 设置中可**检查更新**；升级时配置、插件、壁纸会自动迁移
- 欢迎与问题反馈：[GitHub Issues](https://github.com/ghostLLC/StuartMD/issues)

---

左侧文件树可浏览文件夹；右键文件可在**新窗口**打开。  
有问题欢迎到仓库反馈。祝使用愉快。
