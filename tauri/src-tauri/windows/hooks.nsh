!macro NSIS_HOOK_POSTINSTALL
  ; Markdown 文件类型使用随安装包提供的文档图标。
  IfFileExists "$INSTDIR\file-md.ico" +3 0
    SetErrorLevel 1
    Abort "Markdown document icon is missing"
  ClearErrors
  WriteRegStr SHELL_CONTEXT "Software\Classes\Markdown\DefaultIcon" "" '"$INSTDIR\file-md.ico",0'
  IfErrors 0 +3
    SetErrorLevel 1
    Abort "Markdown document icon registration failed"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
