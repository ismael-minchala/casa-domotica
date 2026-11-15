/*
 * eWeLink (nube, OAuth 2.0) → openHAB
 *
 * La app de desarrollador de eWeLink (rol Standard) no permite el inicio de sesión con
 * contraseña que usa el binding Sonoff, pero sí OAuth 2.0: el usuario inicia sesión en la
 * página de eWeLink, que vuelve a static/ewelink.html con un código; esa página lo envía al
 * item Ewelink_OAuthCode y esta regla lo canjea por el token (válido 30 días, se renueva solo).
 *
 * App ID y App Secret se leen de la configuración del Thing sonoff:account:ewelink
 * (los escribió el usuario); el token se guarda en userdata/ewelink/token.json.
 *
 * Equipos: cada Switch del grupo gEwelinkSw llamado Ewelink_<deviceid> (1 canal) o
 * Ewelink_<deviceid>_<n> (canal n, empezando en 1) se sincroniza cada minuto y sus
 * comandos ON/OFF se envían a la nube. La lista de equipos se guarda en
 * userdata/ewelink/equipos.json (sin datos sensibles).
 */

const log = console;
const Files = Java.type('java.nio.file.Files');
const Paths = Java.type('java.nio.file.Paths');
const StandardCharsets = Java.type('java.nio.charset.StandardCharsets');
const Mac = Java.type('javax.crypto.Mac');
const SecretKeySpec = Java.type('javax.crypto.spec.SecretKeySpec');
const Base64 = Java.type('java.util.Base64');
const HttpClient = Java.type('java.net.http.HttpClient');
const HttpRequest = Java.type('java.net.http.HttpRequest');
const HttpResponse = Java.type('java.net.http.HttpResponse');
const URI = Java.type('java.net.URI');
const Duration = Java.type('java.time.Duration');
const OpenHAB = Java.type('org.openhab.core.OpenHAB');

const THING_CUENTA = 'sonoff:account:ewelink';
const REDIRECT_URL = 'http://127.0.0.1:8080/static/ewelink.html';
const DIR = Paths.get(OpenHAB.getUserDataFolder(), 'ewelink');
const TOKEN_FILE = DIR.resolve('token.json');
const EQUIPOS_FILE = DIR.resolve('equipos.json');
// Equipos que GET /v2/device/thing no lista para esta app (marca "Maker"); se leen por ID
const IDS_EXTRA = ['10000f0c77']; // Luz exterior — Sonoff 4CH
const http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

function credenciales() {
  const t = things.getThing(THING_CUENTA);
  if (!t) return null;
  const c = t.rawThing.getConfiguration();
  const appId = c.get('appId');
  const appSecret = c.get('appSecret');
  if (!appId || !appSecret) return null;
  return { appId: String(appId), appSecret: String(appSecret) };
}

function firmar(secret, datos) {
  const mac = Mac.getInstance('HmacSHA256');
  mac.init(new SecretKeySpec(new java.lang.String(secret).getBytes(StandardCharsets.UTF_8), 'HmacSHA256'));
  return Base64.getEncoder().encodeToString(mac.doFinal(new java.lang.String(datos).getBytes(StandardCharsets.UTF_8)));
}

function nonce() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function leerToken() {
  try {
    if (!Files.exists(TOKEN_FILE)) return null;
    return JSON.parse(String(new java.lang.String(Files.readAllBytes(TOKEN_FILE), StandardCharsets.UTF_8)));
  } catch (e) {
    log.warn('eWeLink: no pude leer el token: ' + e);
    return null;
  }
}

function guardar(ruta, obj) {
  Files.createDirectories(DIR);
  Files.write(ruta, new java.lang.String(JSON.stringify(obj, null, 2)).getBytes(StandardCharsets.UTF_8));
}

function peticion(metodo, url, cabeceras, cuerpo) {
  const b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(15));
  for (const [k, v] of Object.entries(cabeceras)) b.header(k, v);
  if (metodo === 'GET') b.GET();
  else b.method(metodo, HttpRequest.BodyPublishers.ofString(cuerpo || ''));
  const r = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
  let json = null;
  try { json = JSON.parse(String(r.body())); } catch (e) { json = null; }
  return { status: r.statusCode(), json: json };
}

function host(region) {
  return 'https://' + (region || 'us') + '-apia.coolkit.cc';
}

function estado(texto) {
  items.getItem('Ewelink_Estado').postUpdate(texto);
}

// Enlace de inicio de sesión (la firma caduca, así que se regenera cada pocos minutos)
function generarEnlace() {
  const cr = credenciales();
  if (!cr) { estado('Faltan App ID / App Secret en la Cuenta eWeLink'); return; }
  const seq = String(Date.now());
  const url = 'https://c2ccdn.coolkit.cc/oauth/index.html'
    + '?state=openhab'
    + '&clientId=' + encodeURIComponent(cr.appId)
    + '&authorization=' + encodeURIComponent(firmar(cr.appSecret, cr.appId + '_' + seq))
    + '&seq=' + seq
    + '&redirectUrl=' + encodeURIComponent(REDIRECT_URL)
    + '&nonce=' + nonce()
    + '&grantType=authorization_code'
    + '&showQRCode=false';
  items.getItem('Ewelink_LoginUrl').postUpdate(url);
}

function canjearCodigo(valor) {
  const cr = credenciales();
  if (!cr) return;
  const sep = valor.indexOf('|');
  const region = sep >= 0 ? valor.substring(0, sep) : 'us';
  const code = sep >= 0 ? valor.substring(sep + 1) : valor;
  const cuerpo = JSON.stringify({ code: code, redirectUrl: REDIRECT_URL, grantType: 'authorization_code' });
  const r = peticion('POST', host(region) + '/v2/user/oauth/token', {
    'Content-Type': 'application/json',
    'X-CK-Appid': cr.appId,
    'X-CK-Nonce': nonce(),
    'Authorization': 'Sign ' + firmar(cr.appSecret, cuerpo),
  }, cuerpo);
  if (r.json && r.json.error === 0 && r.json.data && r.json.data.accessToken) {
    const d = r.json.data;
    guardar(TOKEN_FILE, { region: region, at: d.accessToken, rt: d.refreshToken, atExp: d.atExpiredTime, rtExp: d.rtExpiredTime, obtenido: Date.now() });
    log.info('eWeLink: autorización correcta (región ' + region + ')');
    estado('Conectado (región ' + region + ')');
    sincronizar();
  } else {
    const err = r.json ? (r.json.error + ' ' + r.json.msg) : ('HTTP ' + r.status);
    log.warn('eWeLink: canje del código falló: ' + err);
    estado('Error al autorizar: ' + err);
  }
  items.getItem('Ewelink_OAuthCode').postUpdate('');
}

function renovarSiHaceFalta(tk, cr) {
  const quedan = (tk.atExp || 0) - Date.now();
  if (quedan > 7 * 86400000) return tk;
  const cuerpo = JSON.stringify({ rt: tk.rt });
  const r = peticion('POST', host(tk.region) + '/v2/user/refresh', {
    'Content-Type': 'application/json',
    'X-CK-Appid': cr.appId,
    'X-CK-Nonce': nonce(),
    'Authorization': 'Bearer ' + tk.at,
  }, cuerpo);
  if (r.json && r.json.error === 0 && r.json.data && r.json.data.at) {
    const d = r.json.data;
    const nuevo = Object.assign({}, tk, { at: d.at, rt: d.rt, atExp: Date.now() + 30 * 86400000, obtenido: Date.now() });
    guardar(TOKEN_FILE, nuevo);
    log.info('eWeLink: token renovado');
    return nuevo;
  }
  log.warn('eWeLink: no se pudo renovar el token: ' + (r.json ? r.json.error + ' ' + r.json.msg : 'HTTP ' + r.status));
  return tk;
}

function api(metodo, ruta, cuerpo) {
  const cr = credenciales();
  let tk = leerToken();
  if (!cr || !tk) return null;
  tk = renovarSiHaceFalta(tk, cr);
  return peticion(metodo, host(tk.region) + ruta, {
    'Content-Type': 'application/json',
    'X-CK-Appid': cr.appId,
    'X-CK-Nonce': nonce(),
    'Authorization': 'Bearer ' + tk.at,
  }, cuerpo);
}

function nombreItem(deviceid, canal, multi) {
  return 'Ewelink_' + deviceid + (multi ? '_' + (canal + 1) : '');
}

function actualizarItem(nombre, valor) {
  const it = items.getItem(nombre, true);
  if (it && it.state !== valor) it.postUpdate(valor);
}

function sincronizar() {
  const r = api('GET', '/v2/device/thing?num=0');
  if (!r) return;
  if (!r.json || r.json.error !== 0) {
    const err = r.json ? (r.json.error + ' ' + r.json.msg) : ('HTTP ' + r.status);
    log.warn('eWeLink: no pude leer los equipos: ' + err);
    estado('Error: ' + err);
    return;
  }
  const lista = (r.json.data.thingList || []).filter((t) => t.itemType === 1 || t.itemType === 2).map((t) => t.itemData);
  // Equipos que la lista general no entrega a esta app (p. ej. marca "Maker"): se piden por ID
  const faltan = IDS_EXTRA.filter((id) => !lista.some((d) => d.deviceid === id));
  if (faltan.length) {
    const r2 = api('POST', '/v2/device/thing', JSON.stringify({ thingList: faltan.map((id) => ({ itemType: 1, id: id })) }));
    if (r2 && r2.json && r2.json.error === 0) {
      (r2.json.data.thingList || []).forEach((t) => lista.push(t.itemData));
    } else {
      log.warn('eWeLink: no pude leer los equipos por ID: ' + (r2 && r2.json ? r2.json.error + ' ' + r2.json.msg : 'sin respuesta'));
    }
  }
  const resumen = lista.map((d) => ({
    deviceid: d.deviceid,
    nombre: d.name,
    modelo: (d.productModel || '') + (d.extra && d.extra.uiid ? ' (uiid ' + d.extra.uiid + ')' : ''),
    online: d.online,
    canales: d.params && d.params.switches ? d.params.switches.length : (d.params && d.params.switch ? 1 : 0),
    params: d.params ? Object.keys(d.params) : [],
  }));
  guardar(EQUIPOS_FILE, resumen);
  for (const d of lista) {
    const p = d.params || {};
    if (Array.isArray(p.switches)) {
      p.switches.forEach((s) => actualizarItem(nombreItem(d.deviceid, s.outlet, true), s.switch === 'on' ? 'ON' : 'OFF'));
    } else if (p.switch) {
      actualizarItem(nombreItem(d.deviceid, 0, false), p.switch === 'on' ? 'ON' : 'OFF');
    }
  }
  estado('Conectado: ' + lista.length + ' equipos, ' + lista.filter((d) => d.online).length + ' en línea');
}

function enviarComando(nombre, comando) {
  const m = /^Ewelink_([0-9a-zA-Z]+)(?:_(\d+))?$/.exec(nombre);
  if (!m) return;
  const valor = comando === 'ON' ? 'on' : 'off';
  const params = m[2] ? { switches: [{ switch: valor, outlet: Number(m[2]) - 1 }] } : { switch: valor };
  const r = api('POST', '/v2/device/thing/status', JSON.stringify({ type: 1, id: m[1], params: params }));
  if (!r || !r.json || r.json.error !== 0) {
    log.warn('eWeLink: comando ' + comando + ' a ' + nombre + ' falló: ' + (r && r.json ? r.json.error + ' ' + r.json.msg : 'sin respuesta'));
  }
  setTimeout(sincronizar, 3000);
}

rules.JSRule({
  name: 'eWeLink: canjear código OAuth',
  triggers: [triggers.ItemCommandTrigger('Ewelink_OAuthCode')],
  execute: (ev) => canjearCodigo(String(ev.receivedCommand)),
});

rules.JSRule({
  name: 'eWeLink: enlace de inicio de sesión',
  triggers: [triggers.GenericCronTrigger('0 */3 * * * ?'), triggers.SystemStartlevelTrigger(100)],
  execute: () => { if (!leerToken()) generarEnlace(); },
});

rules.JSRule({
  name: 'eWeLink: sincronizar equipos',
  triggers: [triggers.GenericCronTrigger('15 * * * * ?')],
  execute: () => { if (leerToken()) sincronizar(); },
});

rules.JSRule({
  name: 'eWeLink: enviar comandos',
  triggers: [triggers.GroupCommandTrigger('gEwelinkSw')],
  execute: (ev) => enviarComando(ev.itemName, String(ev.receivedCommand)),
});

// Al cargar el script
setTimeout(() => { if (!leerToken()) generarEnlace(); else sincronizar(); }, 5000);
