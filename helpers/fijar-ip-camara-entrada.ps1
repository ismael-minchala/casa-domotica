# Fija la IP actual de la cámara Entrada (Amcrest ASH42-B, 192.168.18.204) desactivando su DHCP.
# El NVR (192.168.18.31) ya tiene IP fija; las cámaras Interior y Calle cuelgan de su red PoE interna.
# Uso: clic derecho > "Ejecutar con PowerShell". Pide usuario y clave de la cámara (no se guardan).

$ip = '192.168.18.204'
$cred = Get-Credential -Message "Usuario y clave de la cámara Entrada ($ip)"
if (-not $cred) { exit }
$wc = New-Object Net.WebClient
$wc.Credentials = $cred.GetNetworkCredential()
$base = "http://$ip/cgi-bin/configManager.cgi"

try {
    $lines = $wc.DownloadString("$base`?action=getConfig&name=Network") -split "`n" | ForEach-Object { $_.Trim() }
} catch {
    Write-Host "No se pudo leer la configuración: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Pulsa Enter para cerrar'; exit
}

# Interfaz que tiene la IP actual (eth0 = cable, eth2 = Wi-Fi)
$ifLine = $lines | Where-Object { $_ -match '^table\.Network\.(\w+)\.IPAddress=' + [regex]::Escape($ip) + '$' } | Select-Object -First 1
if (-not $ifLine) { Write-Host "No encontré la interfaz con IP $ip" -ForegroundColor Red; Read-Host 'Pulsa Enter para cerrar'; exit }
$if = ([regex]::Match($ifLine, 'Network\.(\w+)\.')).Groups[1].Value
function Get-Val($k) { (($lines | Where-Object { $_ -like "table.Network.$if.$k=*" }) -split '=', 2)[1] }

$dhcp = Get-Val 'DhcpEnable'
Write-Host "Interfaz $if  DHCP=$dhcp  IP=$ip  Máscara=$(Get-Val 'SubnetMask')  Puerta=$(Get-Val 'DefaultGateway')"
if ($dhcp -eq 'false') { Write-Host 'La IP ya es fija. No hay nada que cambiar.' -ForegroundColor Green; Read-Host 'Pulsa Enter para cerrar'; exit }

$q = "action=setConfig&Network.$if.DhcpEnable=false&Network.$if.IPAddress=$ip" +
     "&Network.$if.SubnetMask=$(Get-Val 'SubnetMask')&Network.$if.DefaultGateway=$(Get-Val 'DefaultGateway')" +
     "&Network.$if.DnsServers[0]=$(Get-Val 'DnsServers[0]')&Network.$if.DnsServers[1]=$(Get-Val 'DnsServers[1]')"
try {
    $r = $wc.DownloadString("$base`?$q")
    Write-Host "Respuesta de la cámara: $($r.Trim())" -ForegroundColor Green
    Write-Host 'IP fija aplicada. La cámara puede tardar unos segundos en volver.'
} catch {
    Write-Host "Error al aplicar: $($_.Exception.Message)" -ForegroundColor Red
}
Read-Host 'Pulsa Enter para cerrar'
