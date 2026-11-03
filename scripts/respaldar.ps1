# Respaldo de la configuración de la casa (openHAB + scripts + proyecto LCN-PRO) en este repositorio git.
# Copia los archivos, BORRA los secretos (contraseñas, claves Tuya, tokens), hace commit y, si hay
# remoto configurado, push. Uso:  powershell -ExecutionPolicy Bypass -File scripts\respaldar.ps1
param([switch]$NoPush)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$git = 'C:\Program Files\Git\cmd\git.exe'
$R = '<REDACTED>'

# Nombres de propiedades JSON / claves .cfg cuyo valor nunca se guarda
$secretName = '(?i)^(password|passwd|pass|pwd|secret|accesssecret|accessid|accesskey|localkey|token|apitoken|apikey|api_key|username)$'
# usuario:clave@ dentro de URLs (rtsp://, http://...)
$urlCreds = '(?i)([a-z][a-z0-9+.-]*://)[^/\s:@"]+:[^/\s@"]+@'

function Clear-Secrets($node) {
    if ($node -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in @($node.PSObject.Properties)) {
            if ($p.Name -match $secretName -and $p.Value -is [string] -and $p.Value) { $p.Value = $R }
            elseif ($p.Value -is [string]) { $p.Value = $p.Value -replace $urlCreds, "`$1$R@" }
            else { Clear-Secrets $p.Value }
        }
    } elseif ($node -is [System.Collections.IEnumerable] -and $node -isnot [string]) {
        foreach ($x in $node) { Clear-Secrets $x }
    }
}

function Copy-Json($src, $dst) {
    $obj = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Clear-Secrets $obj
    New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
    # PowerShell 5.1 escapa < > & ' como \u00xx: se deshace (sigue siendo JSON válido)
    $json = ($obj | ConvertTo-Json -Depth 100) -replace '\\u003c', '<' -replace '\\u003e', '>' -replace '\\u0026', '&' -replace '\\u0027', "'"
    [IO.File]::WriteAllText($dst, $json, (New-Object Text.UTF8Encoding $false))
}

function Copy-Text($src, $dst) {
    $t = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8)
    # key = value en archivos de configuración (no en código, para no romper scripts)
    if ([IO.Path]::GetExtension($src) -in '.cfg', '.txt', '.properties') { $t = [regex]::Replace($t, '(?im)^(\s*[#;]?\s*[\w.\-]*(password|passwd|secret|token|apikey|localkey)[\w.\-]*\s*[=:]\s*)\S.*$', "`$1$R") }
    $t = $t -replace $urlCreds, "`$1$R@"
    New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
    [IO.File]::WriteAllText($dst, $t, (New-Object Text.UTF8Encoding $false))
}

# --- 1. openHAB conf (sin archivos que solo contienen secretos)
$excludeConf = @('services\influxdb-token.txt')
$dstConf = Join-Path $repo 'openhab\conf'
if (Test-Path $dstConf) { Remove-Item $dstConf -Recurse -Force }
Get-ChildItem 'C:\openhab\conf' -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring('C:\openhab\conf\'.Length)
    if ($excludeConf -contains $rel -or $_.Name -match '^readme') { return }
    $dst = Join-Path $dstConf $rel
    if ($_.Extension -eq '.json') { Copy-Json $_.FullName $dst }
    elseif ($_.Extension -in '.mp3', '.png', '.jpg', '.svg', '.ico') { New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item $_.FullName $dst }
    else { Copy-Text $_.FullName $dst }
}

# --- 2. openHAB jsondb (Things, Items, links, páginas UI); users.json nunca se copia
$dstDb = Join-Path $repo 'openhab\jsondb'
if (Test-Path $dstDb) { Remove-Item $dstDb -Recurse -Force }
Get-ChildItem 'C:\openhab\userdata\jsondb' -File -Filter *.json | Where-Object { $_.Name -notin 'users.json', 'thing_status_storage.json' } | ForEach-Object {
    Copy-Json $_.FullName (Join-Path $dstDb $_.Name)
}

# --- 3. Scripts auxiliares (sin el archivo del token)
$dstScr = Join-Path $repo 'helpers'
if (Test-Path $dstScr) { Remove-Item $dstScr -Recurse -Force }
Get-ChildItem 'C:\Users\Ismael\Documents\openhab-energia' -File -Filter *.ps1 | ForEach-Object { Copy-Text $_.FullName (Join-Path $dstScr $_.Name) }

# --- 4. Proyecto LCN-PRO
$dstLcn = Join-Path $repo 'lcn-pro'
New-Item -ItemType Directory -Force $dstLcn | Out-Null
Copy-Item 'C:\Users\Ismael\Documents\LCN-PRO\Casa.lp3' $dstLcn -Force

# --- 5. Commit (y push si hay remoto)
Set-Location $repo
& $git add -A
& $git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { 'Sin cambios desde el último respaldo.'; return }
& $git commit -q -m "Respaldo $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
& $git log -1 --oneline
if (-not $NoPush -and (& $git remote)) { & $git push -q origin HEAD; 'Enviado a GitHub.' }
