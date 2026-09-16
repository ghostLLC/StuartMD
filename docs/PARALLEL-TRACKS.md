# StuartMD 双轨发布策略

| 轨道 | 壳 | 仓库角色 | Release 资产 |
|------|-----|----------|----------------|
| **Stable（稳定）** | pywebview + Python | 仅用于打稳定安装包 | `StuartMD-Setup-x.y.z.exe` |
| **Beta（测试）** | Tauri 2 | **主开发线**（默认源码方向） | `StuartMD-Tauri-x.y.z-setup.exe` |

## 规则

1. **日常开发、PR、默认 clone**：以 `tauri/` + `web/` 为主  
2. **Stable 安装包**：由 `main.py` / `StuartMD.spec` / `installer/StuartMD.iss` 构建，**仍会出现在 Release**  
3. **Beta 安装包**：`tauri/src-tauri` → NSIS/MSI  
4. **版本号**：两边尽量同号（如 1.11.0）；Tauri 资产名可带 `-Tauri-` 与 `-beta`  
5. **默认推荐**：普通用户装 Stable；尝鲜装 Beta  

## 构建

```powershell
# Stable (pywebview)
.\build-installer.bat

# Beta (Tauri)
cd tauri\src-tauri
# 需 VS Build Tools + Windows SDK
cargo tauri build
```

## Release 说明模板

- Stable: 生产可用  
- Beta: 功能对齐前端，壳为 Tauri，可能有系统集成差异（关联/更新等）  
