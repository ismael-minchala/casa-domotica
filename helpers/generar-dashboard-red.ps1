# Genera red-casa.json (dashboard "Red - Casa" de Grafana) a partir de las medidas net_* de monitor-red.ps1.
# Para instalarlo hay que copiarlo a C:\Program Files\GrafanaLabs\grafana\dashboards-openhab (requiere administrador).
$ds = @{ type = 'influxdb'; uid = 'influx-openhab' }
$rango = 'range(start: v.timeRangeStart, stop: v.timeRangeStop)'
$tz = 'location: {zone: "UTC", offset: -5h}'

function Serie([string]$medida, [string]$campo, [string]$filtro = '') {
    $f = if ($filtro) { " and $filtro" } else { '' }
    "from(bucket: `"data`")`n  |> $rango`n  |> filter(fn: (r) => r._measurement == `"$medida`" and r._field == `"$campo`"$f)"
}

# Agrupa por hora local del dia (00-23) y deja una columna por serie.
function PorHora([string]$fuente, [string]$etiqueta, [string]$agregado) {
@"
import "date"
$fuente
  |> map(fn: (r) => {
      h = date.hour(t: r._time, $tz)
      return {hora: if h < 10 then "0" + string(v: h) else string(v: h), serie: $etiqueta, _value: float(v: r._value)}
    })
  |> group(columns: ["hora", "serie"])
  |> $agregado
  |> group()
  |> pivot(rowKey: ["hora"], columnKey: ["serie"], valueColumn: "_value")
  |> sort(columns: ["hora"])
"@
}

function Barras([int]$id, [string]$titulo, [int]$x, [int]$y, [int]$w, [string]$unidad, [string]$consulta) {
    [ordered]@{
        id = $id; type = 'barchart'; title = $titulo; datasource = $ds
        gridPos = @{ x = $x; y = $y; w = $w; h = 8 }
        targets = @(@{ refId = 'A'; query = $consulta })
        fieldConfig = @{ defaults = @{ unit = $unidad; min = 0 }; overrides = @() }
        options = @{ xField = 'hora'; orientation = 'vertical'; legend = @{ displayMode = 'list'; placement = 'bottom'; showLegend = $true }; tooltip = @{ mode = 'multi' } }
    }
}

function Linea([int]$id, [string]$titulo, [int]$x, [int]$y, [int]$w, [string]$unidad, [object[]]$consultas) {
    $refs = 'A','B','C','D'
    $i = -1
    [ordered]@{
        id = $id; type = 'timeseries'; title = $titulo; datasource = $ds
        gridPos = @{ x = $x; y = $y; w = $w; h = 8 }
        targets = @($consultas | ForEach-Object { $i++; @{ refId = $refs[$i]; query = $_ } })
        fieldConfig = @{ defaults = @{ unit = $unidad; min = 0; custom = @{ spanNulls = 3600000; lineWidth = 1; showPoints = 'auto' } }; overrides = @() }
        options = @{ legend = @{ displayMode = 'list'; placement = 'bottom'; showLegend = $true }; tooltip = @{ mode = 'multi' } }
    }
}

$bajada = Serie 'net_velocidad' 'curl_mbps' 'r.sentido == "bajada"'
$subida = Serie 'net_velocidad' 'curl_mbps' 'r.sentido == "subida"'
$pingInt = Serie 'net_ping' 'p95_ms' '(r.destino == "cloudflare" or r.destino == "google")'
$pingLan = Serie 'net_ping' 'p95_ms' '(r.destino == "router" or r.destino == "nvr" or r.destino == "cam_entrada")'
$perdida = Serie 'net_ping' 'perdida_pct'

$paneles = @(
    (Barras 1 'Bajada media por hora del día' 0 0 12 'Mbits' (PorHora $bajada 'r.origen' 'mean()')),
    (Barras 2 'Bajada mínima por hora del día' 12 0 12 'Mbits' (PorHora $bajada 'r.origen' 'min()')),
    (Barras 3 'Latencia p95 a internet por hora del día' 0 8 8 'ms' (PorHora $pingInt 'r.destino' 'mean()')),
    (Barras 4 'Latencia p95 en la casa por hora del día' 8 8 8 'ms' (PorHora $pingLan 'r.destino' 'mean()')),
    (Barras 5 'Pérdida de pings por hora del día' 16 8 8 'percent' (PorHora $perdida 'r.destino' 'mean()')),
    (Linea 6 'Velocidad en el tiempo' 0 16 24 'Mbits' @($bajada, $subida)),
    (Linea 7 'Latencia p95 a internet' 0 24 12 'ms' @($pingInt)),
    (Linea 8 'DNS' 12 24 12 'ms' @((Serie 'net_dns' 'ms'))),
    (Linea 9 'Tráfico de fondo del servidor' 0 32 12 'Mbits' @((Serie 'net_servidor' 'fondo_rx_mbps'), (Serie 'net_servidor' 'fondo_tx_mbps'))),
    (Linea 10 'Cortes de myopenHAB (cada 5 min) y procesos ffmpeg' 12 32 12 'short' @((Serie 'net_servidor' 'nube_cortes'), (Serie 'net_servidor' 'ffmpeg')))
)

$tablero = [ordered]@{
    uid = 'red-casa'; title = 'Red - Casa'; tags = @('red'); schemaVersion = 39; version = 1
    editable = $true; timezone = 'browser'; refresh = '5m'
    time = @{ from = 'now-7d'; to = 'now' }
    panels = $paneles
}
$destino = Join-Path $PSScriptRoot 'red-casa.json'
[IO.File]::WriteAllText($destino, ($tablero | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
"Generado $destino con $($paneles.Count) paneles"
