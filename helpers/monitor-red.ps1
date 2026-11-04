# Monitor de la red de casa: mide cada 5 min y guarda en InfluxDB (org Home, bucket data).
# Medidas: net_ping, net_dns, net_servidor y, cada 30 min, net_velocidad (bajada; subida cada hora).
# Consumo aproximado de las pruebas de velocidad: 7-9 GB al dia.
# Uso: monitor-red.ps1 [-Velocidad] [-SinGuardar]
#   -Velocidad  fuerza la prueba de velocidad en esta pasada
#   -SinGuardar imprime las lineas en vez de enviarlas a InfluxDB
param([switch]$Velocidad, [switch]$SinGuardar)

$ErrorActionPreference = 'Stop'
$adaptador = 'Wi-Fi'
$tokenFile = 'C:\openhab\conf\services\influxdb-token.txt'
$logFile   = Join-Path $PSScriptRoot 'monitor-red.log'
$openhabLog = 'C:\openhab\userdata\logs\openhab.log'
$inicio = Get-Date
$ts = [DateTimeOffset]::new($inicio).ToUnixTimeSeconds()
$lineas = New-Object System.Collections.ArrayList

function Registrar([string]$texto) {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item $logFile "$logFile.1" -Force }
    Add-Content -Path $logFile -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $texto) -Encoding UTF8
}

function Num([double]$v) { $v.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture) }

# --- Latencia y perdida: 30 pings a 1 por segundo, en paralelo ---
$destinos = [ordered]@{
    router      = '192.168.18.1'
    nvr         = '192.168.18.31'
    cam_entrada = '192.168.18.204'
    cloudflare  = '1.1.1.1'
    google      = '8.8.8.8'
}
$rtt = @{}; foreach ($d in $destinos.Keys) { $rtt[$d] = New-Object System.Collections.ArrayList }
$ad0 = Get-NetAdapterStatistics -Name $adaptador; $t0 = Get-Date
$envios = 30
foreach ($i in 1..$envios) {
    $vuelta = [Diagnostics.Stopwatch]::StartNew()
    $tareas = foreach ($d in $destinos.Keys) {
        $p = New-Object System.Net.NetworkInformation.Ping
        [pscustomobject]@{ D = $d; Task = $p.SendPingAsync($destinos[$d], 900) }
    }
    [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]($tareas.Task), 1000)
    foreach ($x in $tareas) {
        if ($x.Task.Status -eq 'RanToCompletion' -and $x.Task.Result.Status -eq 'Success') { [void]$rtt[$x.D].Add([int]$x.Task.Result.RoundtripTime) }
    }
    $resto = 1000 - $vuelta.ElapsedMilliseconds
    if ($resto -gt 0) { Start-Sleep -Milliseconds $resto }
}
$ad1 = Get-NetAdapterStatistics -Name $adaptador; $seg = ((Get-Date) - $t0).TotalSeconds
$fondoRx = ($ad1.ReceivedBytes - $ad0.ReceivedBytes) * 8 / $seg / 1e6
$fondoTx = ($ad1.SentBytes - $ad0.SentBytes) * 8 / $seg / 1e6

foreach ($d in $destinos.Keys) {
    $v = @($rtt[$d] | Sort-Object)
    $perdida = 100 * ($envios - $v.Count) / $envios
    if ($v.Count) {
        $p50 = $v[[int][math]::Floor($v.Count * 0.5)]
        $p95 = $v[[math]::Min($v.Count - 1, [int][math]::Floor($v.Count * 0.95))]
        [void]$lineas.Add("net_ping,destino=$d perdida_pct=$(Num $perdida),p50_ms=$p50,p95_ms=$p95,max_ms=$($v[-1]) $ts")
    } else {
        [void]$lineas.Add("net_ping,destino=$d perdida_pct=$(Num $perdida) $ts")
    }
}

# --- DNS: dominio distinto en cada pasada para no medir siempre la cache ---
$dominios = 'www.wikipedia.org','www.netflix.com','github.com','www.amazon.com','www.apple.com','www.ucuenca.edu.ec'
$dominio = $dominios[([int][math]::Floor($inicio.Minute / 5)) % $dominios.Count]
# Primera consulta descartada: cargar el modulo DnsClient tarda mas de 1 s y falsearia el primer dato.
try { [void](Resolve-DnsName 'localhost' -Type A -Server '192.168.18.1' -DnsOnly -NoHostsFile -ErrorAction Stop) } catch {}
foreach ($s in ([ordered]@{ router = '192.168.18.1'; cloudflare = '1.1.1.1'; google = '8.8.8.8' }).GetEnumerator()) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        [void](Resolve-DnsName $dominio -Type A -Server $s.Value -DnsOnly -NoHostsFile -ErrorAction Stop)
        [void]$lineas.Add("net_dns,servidor=$($s.Key) ms=$($sw.ElapsedMilliseconds),ok=1i $ts")
    } catch {
        [void]$lineas.Add("net_dns,servidor=$($s.Key) ok=0i $ts")
    }
}

# --- Estado del servidor: Wi-Fi, trafico de fondo, ffmpeg y cortes de la nube ---
$wlan = netsh wlan show interfaces | Out-String
$senal  = [regex]::Match($wlan, '(?m)^\s*Signal\s*:\s*(\d+)').Groups[1].Value
$enlace = [regex]::Match($wlan, '(?m)^\s*Receive rate.*:\s*([\d.]+)').Groups[1].Value
$ffmpeg = @(Get-Process ffmpeg -ErrorAction SilentlyContinue).Count
$desde = $inicio.AddMinutes(-5).ToString('yyyy-MM-dd HH:mm:ss')
$cortes = 0
try {
    $cortes = @(Get-Content $openhabLog -Tail 3000 | Where-Object { $_ -match 'Socket\.IO disconnected' -and $_.Substring(0, 19) -ge $desde }).Count
} catch { Registrar "no se pudo leer openhab.log: $($_.Exception.Message)" }
$campos = "fondo_rx_mbps=$(Num $fondoRx),fondo_tx_mbps=$(Num $fondoTx),ffmpeg=${ffmpeg}i,nube_cortes=${cortes}i"
if ($senal)  { $campos += ",senal_pct=$senal" }
if ($enlace) { $campos += ",enlace_mbps=$enlace" }
[void]$lineas.Add("net_servidor $campos $ts")

# --- Velocidad: varios flujos simultaneos con tope de tiempo ---
function Medir-Bajada([string]$etiqueta, [string]$url, [int]$flujos, [int]$tope, [string]$extra) {
    $tmp = Join-Path $env:TEMP ("monred_" + [guid]::NewGuid().ToString('N'))
    $a0 = (Get-NetAdapterStatistics -Name $adaptador).ReceivedBytes; $t = Get-Date
    $procs = foreach ($i in 1..$flujos) {
        Start-Process curl.exe -ArgumentList "-s -L $extra -o NUL --max-time $tope -w `"%{http_code},%{speed_download}`" `"$url`"" -PassThru -NoNewWindow -RedirectStandardOutput "$tmp.$i"
    }
    $procs | ForEach-Object { $_.WaitForExit() }
    $seg = ((Get-Date) - $t).TotalSeconds
    $a1 = (Get-NetAdapterStatistics -Name $adaptador).ReceivedBytes
    $suma = 0.0; $validos = 0
    foreach ($i in 1..$flujos) {
        $x = (Get-Content "$tmp.$i" -Raw) -split ','
        Remove-Item "$tmp.$i"
        if ($x[0] -eq '200') { $suma += [double]::Parse($x[1], [Globalization.CultureInfo]::InvariantCulture); $validos++ }
    }
    if ($validos) {
        "net_velocidad,sentido=bajada,origen=$etiqueta curl_mbps=$(Num ($suma * 8 / 1e6)),adaptador_mbps=$(Num (($a1 - $a0) * 8 / $seg / 1e6)),fondo_mbps=$(Num $fondoRx),flujos=${validos}i $ts"
    } else {
        Registrar "bajada $etiqueta sin respuesta valida"
    }
}

function Medir-Subida([int]$flujos, [int]$tope, [int]$mb) {
    $tmp = Join-Path $env:TEMP ("monred_" + [guid]::NewGuid().ToString('N'))
    $f = "$tmp.bin"
    $fs = [IO.File]::Create($f); $fs.SetLength($mb * 1MB); $fs.Close()
    $a0 = (Get-NetAdapterStatistics -Name $adaptador).SentBytes; $t = Get-Date
    $procs = foreach ($i in 1..$flujos) {
        Start-Process curl.exe -ArgumentList "-s -o NUL --max-time $tope -w `"%{http_code},%{speed_upload}`" -H `"Referer: https://speed.cloudflare.com/`" -X POST --data-binary `"@$f`" https://speed.cloudflare.com/__up" -PassThru -NoNewWindow -RedirectStandardOutput "$tmp.$i"
    }
    $procs | ForEach-Object { $_.WaitForExit() }
    $seg = ((Get-Date) - $t).TotalSeconds
    $a1 = (Get-NetAdapterStatistics -Name $adaptador).SentBytes
    $suma = 0.0; $validos = 0
    foreach ($i in 1..$flujos) {
        $x = (Get-Content "$tmp.$i" -Raw) -split ','
        Remove-Item "$tmp.$i"
        # Un flujo cortado por el tope no llega a tener codigo HTTP, pero su velocidad sigue siendo valida.
        $vel = [double]::Parse($x[1], [Globalization.CultureInfo]::InvariantCulture)
        if ($vel -gt 0) { $suma += $vel; $validos++ }
    }
    Remove-Item $f
    if ($validos) {
        "net_velocidad,sentido=subida,origen=cloudflare curl_mbps=$(Num ($suma * 8 / 1e6)),adaptador_mbps=$(Num (($a1 - $a0) * 8 / $seg / 1e6)),fondo_mbps=$(Num $fondoTx),flujos=${validos}i $ts"
    } else {
        Registrar 'subida sin respuesta valida'
    }
}

$tocaBajada = $Velocidad -or (($inicio.Minute % 30) -lt 5)
$tocaSubida = $Velocidad -or ($inicio.Minute -lt 5)
if ($tocaBajada) {
    $l = Medir-Bajada 'cloudflare' 'https://speed.cloudflare.com/__down?bytes=25000000' 4 6 '-H "Referer: https://speed.cloudflare.com/"'
    if ($l) { [void]$lineas.Add($l) }
    $l = Medir-Bajada 'ovh' 'https://proof.ovh.net/files/1Gb.dat' 4 6 ''
    if ($l) { [void]$lineas.Add($l) }
}
if ($tocaSubida) {
    $l = Medir-Subida 4 6 15
    if ($l) { [void]$lineas.Add($l) }
}

# --- Envio ---
$cuerpo = $lineas -join "`n"
if ($SinGuardar) { $cuerpo; return }
try {
    $token = (Get-Content $tokenFile -Raw).Trim()
    $bytes = [Text.Encoding]::UTF8.GetBytes($cuerpo)
    [void](Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8086/api/v2/write?org=Home&bucket=data&precision=s' -Method Post -Headers @{ Authorization = "Token $token" } -ContentType 'text/plain; charset=utf-8' -Body $bytes -TimeoutSec 15)
} catch {
    Registrar "error al escribir en InfluxDB: $($_.Exception.Message)"
    exit 1
}
