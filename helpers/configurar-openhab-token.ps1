# Guarda un token de API de openHAB para que Claude pueda organizar ítems y páginas sin reiniciar.
# Crear el token: openHAB (http://localhost:8080) > icono de usuario abajo a la izquierda >
#   "Create new API token" > nombre "claude-fase5", scope vacío > copiar el token.
# Para revocarlo después: misma pantalla del perfil > borrar el token.
# Uso: clic derecho > "Ejecutar con PowerShell"

$dest = Join-Path $PSScriptRoot 'openhab-token.txt'

$secure = Read-Host 'Pega el token de API de openHAB' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $token = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)).Trim()
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

try {
    # Listing Things is admin-only (anonymous access gets 401), so success proves admin rights
    $null = Invoke-RestMethod 'http://127.0.0.1:8080/rest/things?summary=true' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 15
    Write-Host 'Token verificado: tiene permisos de administrador.'
} catch {
    Write-Host "openHAB rechazó el token: $($_.Exception.Message)"
    Read-Host 'Pulsa Enter para cerrar'
    exit 1
}

[IO.File]::WriteAllText($dest, $token, (New-Object Text.UTF8Encoding($false)))
$token = $null
Write-Host "Token guardado en $dest"
Read-Host 'Pulsa Enter para cerrar'
