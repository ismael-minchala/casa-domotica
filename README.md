# Casa domótica — respaldo de configuración

Respaldo de la configuración del servidor domótico (openHAB 5.2.3 en Windows, bus LCN vía LCN-PKE,
Tuya, Sonoff vía eWeLink, aspiradora Roborock, cámaras Amcrest por NVR, inversor solar vía DessMonitor,
InfluxDB/Grafana). Documentación técnica en [`docs`](docs/README.md).

| Carpeta | Contenido | Origen |
|---|---|---|
| `openhab/conf` | sitemap, páginas HTML (flujo de energía, energía diaria), reglas JS, items, persistencia, servicios | `C:\openhab\conf` |
| `openhab/jsondb` | Things, Items, enlaces, metadatos, páginas y widgets de MainUI | `C:\openhab\userdata\jsondb` |
| `helpers` | scripts para introducir credenciales y configurar servicios | `Documents\openhab-energia` |
| `lcn-pro` | proyecto LCN-PRO `Casa.lp3` | `Documents\LCN-PRO` |

## Secretos

Los secretos **no** están en este repositorio: contraseñas, claves Tuya (`localKey`, `accessSecret`),
tokens de InfluxDB/openHAB y `users.json` se reemplazan por `<REDACTED>` o se excluyen.
Al restaurar hay que volver a introducirlos (con los scripts de `helpers`).

## Hacer un respaldo

```powershell
powershell -ExecutionPolicy Bypass -File scripts\respaldar.ps1
```

## Restaurar

1. Instalar openHAB 5.2.3 y los add-ons de `openhab/conf/services/addons.cfg`.
2. Con openHAB detenido, copiar `openhab/conf` a `C:\openhab\conf` y `openhab/jsondb` a `C:\openhab\userdata\jsondb`.
3. Reintroducir las credenciales marcadas `<REDACTED>` (Things de cámaras, LCN, Tuya) y los tokens.
4. Iniciar openHAB.
