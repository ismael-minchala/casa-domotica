# Guarda las credenciales de DessMonitor para openHAB.
# La contraseña no se guarda: solo su huella SHA-1, que es lo que firma las peticiones a la API.
# Uso: clic derecho > "Ejecutar con PowerShell", o:  powershell -ExecutionPolicy Bypass -File configurar-dessmonitor.ps1

$destDir = 'C:\openhab\conf\dessmonitor'
$dest = Join-Path $destDir 'dessmonitor.json'

$usuario = Read-Host 'Usuario de DessMonitor (correo)'
$secure = Read-Host 'Contraseña de DessMonitor' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $sha = [Security.Cryptography.SHA1]::Create()
    $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | ForEach-Object { $_.ToString('x2') })
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $plain = $null
}

$config = [ordered]@{
    usuario      = $usuario.Trim()
    passwordSha1 = $hash
    companyKey   = 'bnrl_frRFjEz8Mkn'
    dispositivo  = @{}
    mapa         = @{}
}

New-Item -ItemType Directory -Force $destDir | Out-Null
[IO.File]::WriteAllText($dest, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Write-Host "Credenciales guardadas en $dest"
Write-Host 'openHAB las usará en la próxima lectura (máximo 2 minutos).'
Read-Host 'Pulsa Enter para cerrar'
