; StuartMD Inno Setup installer script
; Build: ISCC.exe installer\StuartMD.iss

#define MyAppName "StuartMD"
#define MyAppVersion "1.4.1"
#define MyAppPublisher "StuartMD"
#define MyAppURL "https://github.com/ghostLLC/StuartMD"
#define MyAppExeName "StuartMD.exe"
#define MyAppProgId "StuartMD.Markdown"
#define BuildDir "..\dist\StuartMD"

[Setup]
AppId={{C5E82F38-4D9B-4A16-8B71-8D3F2AE9B602}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
; Allow user to change install directory in wizard (DisableDirPage must stay unset)
AllowNoIcons=yes
DisableProgramGroupPage=yes
LicenseFile=
OutputDir=..\dist-installer
OutputBaseFilename=StuartMD-Setup-{#MyAppVersion}
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesAssociations=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "chinesetraditional"; MessagesFile: "ChineseTraditional.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktopIcon}"; GroupDescription: "{cm:TaskExtra}"
Name: "associate"; Description: "{cm:TaskAssociate}"; GroupDescription: "{cm:TaskFileAssoc}"
Name: "quicklaunch"; Description: "{cm:TaskQuickLaunch}"; GroupDescription: "{cm:TaskExtra}"; Flags: unchecked

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallStuartMD}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: quicklaunch

[CustomMessages]
chinesesimplified.LaunchProgram=启动 %1
chinesesimplified.UninstallStuartMD=卸载 %1
chinesesimplified.TaskDesktopIcon=创建桌面快捷方式
chinesesimplified.TaskAssociate=关联 Markdown 文件 (.md / .markdown)
chinesesimplified.TaskQuickLaunch=创建快速启动图标
chinesesimplified.TaskExtra=附加选项
chinesesimplified.TaskFileAssoc=文件关联
chinesesimplified.MarkdownDoc=Markdown 文档
chinesetraditional.LaunchProgram=啟動 %1
chinesetraditional.UninstallStuartMD=解除安裝 %1
chinesetraditional.TaskDesktopIcon=建立桌面捷徑
chinesetraditional.TaskAssociate=關聯 Markdown 檔案 (.md / .markdown)
chinesetraditional.TaskQuickLaunch=建立快速啟動圖示
chinesetraditional.TaskExtra=附加選項
chinesetraditional.TaskFileAssoc=檔案關聯
chinesetraditional.MarkdownDoc=Markdown 文件
english.LaunchProgram=Launch %1
english.UninstallStuartMD=Uninstall %1
english.TaskDesktopIcon=Create a desktop shortcut
english.TaskAssociate=Associate Markdown files (.md / .markdown)
english.TaskQuickLaunch=Create a Quick Launch shortcut
english.TaskExtra=Additional icons:
english.TaskFileAssoc=File associations:
english.MarkdownDoc=Markdown Document

[Registry]
; Register as Markdown handler (HKCU — no admin required)
Root: HKA; Subkey: "Software\Classes\{#MyAppProgId}"; ValueType: string; ValueData: "{cm:MarkdownDoc}"; Flags: uninsdeletekey; Tasks: associate
Root: HKA; Subkey: "Software\Classes\{#MyAppProgId}\DefaultIcon"; ValueType: string; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey; Tasks: associate
Root: HKA; Subkey: "Software\Classes\{#MyAppProgId}\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey; Tasks: associate
Root: HKA; Subkey: "Software\Classes\.md"; ValueType: string; ValueData: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associate
Root: HKA; Subkey: "Software\Classes\.markdown"; ValueType: string; ValueData: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associate
Root: HKA; Subkey: "Software\Classes\.mdown"; ValueType: string; ValueData: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associate
Root: HKA; Subkey: "Software\Classes\.mkd"; ValueType: string; ValueData: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associate
; Open with context menu always available
Root: HKA; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueData: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associate
Root: HKA; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueData: "{#MyAppProgId}"; Flags: uninsdeletevalue; Tasks: associate
; App Paths for Win+R / shell
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\{#MyAppExeName}"; ValueType: string; ValueData: "{app}\{#MyAppExeName}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\{#MyAppExeName}"; ValueType: string; ValueName: "Path"; ValueData: "{app}"; Flags: uninsdeletekey
; Install location for ARP
Root: HKA; Subkey: "Software\{#MyAppName}"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\{#MyAppName}"; ValueType: string; ValueName: "Version"; ValueData: "{#MyAppVersion}"; Flags: uninsdeletekey

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; optional: leave user settings in %APPDATA%\StuartMD for safety
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
