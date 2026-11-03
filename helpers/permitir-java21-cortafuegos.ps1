# Permite que openHAB (Java 21) reciba conexiones de la red local:
# acceso desde móviles/otros PC al puerto 8080 y descubrimiento de equipos Tuya (UDP 6666/6667).
# Uso: clic derecho > "Ejecutar con PowerShell" (pedirá permiso de administrador).

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$java = 'C:\Program Files\Zulu\zulu-21\bin\java.exe'
foreach ($proto in 'TCP', 'UDP') {
    $name = "openHAB Java 21 ($proto)"
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Program $java -Protocol $proto `
        -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
    Write-Host "Regla creada: $name"
}
Read-Host 'Listo. Pulsa Enter para cerrar'
