' Lanza monitor-red.ps1 sin mostrar ninguna ventana (la tarea programada corre cada 5 min).
Dim carpeta
carpeta = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & carpeta & "\monitor-red.ps1""", 0, True
