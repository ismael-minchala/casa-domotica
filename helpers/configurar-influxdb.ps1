# Guarda el token de InfluxDB para openHAB y Grafana.
# Antes: en http://localhost:8086 crea la cuenta (organización "casa", bucket "openhab")
# y genera un API token con lectura y escritura sobre el bucket "openhab".
# Uso: clic derecho > "Ejecutar con PowerShell"

$services = 'C:\openhab\conf\services'
$utf8 = New-Object Text.UTF8Encoding($false)

$secure = Read-Host 'Pega el API token de InfluxDB' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim()
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ($token.Length -lt 20) {
    Write-Host 'El token parece demasiado corto; no se guardó nada.'
    Read-Host 'Pulsa Enter para cerrar'
    exit 1
}

try {
    $null = Invoke-RestMethod 'http://127.0.0.1:8086/api/v2/buckets?name=openhab' -Headers @{ Authorization = "Token $token" } -TimeoutSec 10
    Write-Host 'Token verificado contra InfluxDB.'
} catch {
    Write-Host "InfluxDB rechazó el token: $($_.Exception.Message)"
    Read-Host 'Pulsa Enter para cerrar'
    exit 1
}

# openHAB: para V2, "db" es la organización y "retentionPolicy" el bucket
$cfg = @"
url=http://127.0.0.1:8086
version=V2
token=$token
db=casa
retentionPolicy=openhab
"@
[IO.File]::WriteAllText("$services\influxdb.cfg", $cfg, $utf8)
# Grafana lo lee con `$__file{...}` desde su fuente de datos aprovisionada
[IO.File]::WriteAllText("$services\influxdb-token.txt", $token, $utf8)
$token = $null

Write-Host "Configuración guardada en $services\influxdb.cfg"
Read-Host 'Pulsa Enter para cerrar'
