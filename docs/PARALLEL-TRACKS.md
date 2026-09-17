# StuartMD 双轨发布策略

| 轨道 | 壳 | 仓库角色 | Release 资产 |
|------|-----|----------|----------------|
| **Stable（冻结）** | pywebview + Python | 历史稳定包，**不再功能更新** | `StuartMD-Setup-1.13.1.exe` |
| **Main（唯一维护线）** | Tauri 2 | **主开发线** | `StuartMD-Tauri-x.y.z-setup.exe` |

## 规则（2026-09-15 起）

1. **只更新维护 Tauri**：日常开发、版本 bump、Release 均以 `tauri/` + `web/` 为准  
2. **Stable 1.13.1**：仅作回退安装包保留，不再出新版本  
3. **版本号**：Tauri 轨道独立递增（1.14.0+）  
4. **安装包**：NSIS（`currentUser`，中/英）  
   - 默认安装目录：`%LOCALAPPDATA%\StuartMD`（Tauri NSIS currentUser）  
   - 配置仍存：`%APPDATA%\StuartMD\settings.json`  

## 构建

```powershell
# Main (Tauri)
cd tauri\src-tauri
cargo tauri build
```

## Release 说明模板

- StuartMD-Tauri：主版本，功能完整，持续更新  
- StuartMD-Setup-1.13.1：旧 pywebview 稳定包，仅供回退  
