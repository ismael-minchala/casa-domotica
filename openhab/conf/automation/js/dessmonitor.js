/*
 * DessMonitor (Eybond) cloud -> openHAB
 *
 * Polls https://api.dessmonitor.com/public/ and updates the items in
 * conf/items/energia.items. Credentials are read from
 * conf/dessmonitor/dessmonitor.json (created with configurar-dessmonitor.ps1);
 * only the SHA-1 of the password is stored there.
 *
 * API reference: github.com/andreas-glaser/ha-dessmonitor (api.py, const.py)
 */

const BASE_URL = 'https://api.dessmonitor.com/public/';
const DEFAULT_COMPANY_KEY = 'bnrl_frRFjEz8Mkn';
const APP_ID = 'openhab-casa';
const APP_VERSION = '1.0.0';
// The cloud regularly takes >15 s to answer (4 timeouts on 2026-10-31)
const HTTP_TIMEOUT_MS = 30000;

const Files = Java.type('java.nio.file.Files');
const Paths = Java.type('java.nio.file.Paths');
const JString = Java.type('java.lang.String');
const MessageDigest = Java.type('java.security.MessageDigest');
const URLEncoder = Java.type('java.net.URLEncoder');
const OpenHAB = Java.type('org.openhab.core.OpenHAB');

const log = console;

// Item -> candidate data point titles (first match wins, case-insensitive).
// Override or extend with "mapa" in dessmonitor.json once the real titles are known.
// Titles verified on devcode 2462 (off-grid inverter + separate PV controller, 24 V battery).
const DEFAULT_MAP = {
  Casa_CargaPct: ['Load percentage', 'Load Percent', 'Output Load Percent'],
  Salida_Voltaje: ['Output Voltage', 'AC Output Voltage'],
  Salida_Frecuencia: ['Output frequency'],
  Solar_Voltaje: ['PV Voltage'],
  Solar_Corriente: ['Controller charging current', 'PV Charging Current'],
  Solar_CargaEstado: ['Controller charging status'],
  Bateria_SOC: ['Battery capacity', 'Battery SOC', 'SOC'],
  Bateria_Voltaje: ['Battery voltage'],
  Bateria_Llena: ['Battery voltage is full'],
  Red_Voltaje: ['Input Voltage', 'Grid Voltage', 'AC Input Voltage'],
  Red_Frecuencia: ['Input frequency', 'Grid Frequency'],
  Red_CargaEstado: ['Inverter charging status'],
  Inversor_Modo: ['System operating status', 'Working State', 'Operating Mode'],
  Inversor_Temperatura: ['Machine temperature', 'Inverter Temperature'],
  Controlador_Temperatura: ['Controller temperature'],
};

const ALARM_TITLES = ['Controller failure alarm', 'Controller warning alarm', 'Inverter failure alarm', 'Inverter warning alarm'];

const KNOWN_UNITS = ['W', 'kW', 'V', 'A', '%', '°C', 'kWh', 'Wh', 'Hz', 'VA', 'kVA'];

// Session state survives between rule runs while this file stays loaded
let session = { token: null, secret: null, expiresAt: 0 };
let device = null;
let titlesLogged = false;

function sha1(text) {
  const bytes = MessageDigest.getInstance('SHA-1').digest(new JString(text).getBytes('UTF-8'));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += ((bytes[i] & 0xff) + 0x100).toString(16).substring(1);
  }
  return hex;
}

function enc(value) {
  return URLEncoder.encode(String(value), 'UTF-8');
}

function loadConfig() {
  const path = Paths.get(OpenHAB.getConfigFolder(), 'dessmonitor', 'dessmonitor.json');
  if (!Files.exists(path)) {
    return null;
  }
  return JSON.parse(String(Files.readString(path)));
}

function actionString(action, params) {
  let s = '&action=' + action;
  for (const [k, v] of params) {
    s += '&' + k + '=' + enc(v);
  }
  return s;
}

function callApi(url) {
  const body = actions.HTTP.sendHttpGetRequest(url, HTTP_TIMEOUT_MS);
  if (!body) {
    throw new Error('Sin respuesta del servidor');
  }
  const data = JSON.parse(body);
  if (data.err && data.err !== 0) {
    throw new Error('API err ' + data.err + ': ' + (data.desc || ''));
  }
  return data.dat;
}

function authenticate(cfg) {
  const salt = String(Date.now());
  const params = [
    ['usr', cfg.usuario],
    ['company-key', cfg.companyKey || DEFAULT_COMPANY_KEY],
    ['source', '1'],
    ['_app_client_', 'web'],
    ['_app_id_', APP_ID],
    ['_app_version_', APP_VERSION],
  ];
  const act = actionString('authSource', params);
  const sign = sha1(salt + cfg.passwordSha1.toLowerCase() + act);
  const dat = callApi(BASE_URL + '?sign=' + sign + '&salt=' + salt + act);
  if (!dat || !dat.token || !dat.secret || !(dat.expire > 0)) {
    throw new Error('Respuesta de autenticación incompleta');
  }
  session = { token: dat.token, secret: dat.secret, expiresAt: Date.now() + dat.expire * 1000 };
  log.info('DessMonitor: sesión iniciada, expira en ' + Math.round(dat.expire / 3600) + ' h');
}

function signedCall(cfg, action, params) {
  // Renew the token when less than 5 minutes remain
  if (!session.token || Date.now() > session.expiresAt - 300000) {
    authenticate(cfg);
  }
  const salt = String(Date.now());
  const act = actionString(action, params);
  const sign = sha1(salt + session.secret + session.token + act);
  return callApi(BASE_URL + '?sign=' + sign + '&salt=' + salt + '&token=' + session.token + act);
}

function discoverDevice(cfg) {
  const d = cfg.dispositivo || {};
  if (d.pn && d.devcode && d.devaddr !== undefined && d.sn) {
    return { pid: d.pid, pn: d.pn, devcode: d.devcode, devaddr: d.devaddr, sn: d.sn };
  }
  const plants = (signedCall(cfg, 'queryPlants', [['pagesize', '50']]) || {}).plant || [];
  if (plants.length === 0) {
    throw new Error('La cuenta no tiene plantas');
  }
  log.info('DessMonitor: plantas en la cuenta: ' + plants.map((p) => p.pid + ' "' + (p.pname || p.name || '') + '"').join(', '));
  const pid = d.pid || plants[0].pid;
  const collectors = (signedCall(cfg, 'webQueryCollectorsEs', [['pid', pid], ['page', '0'], ['pagesize', '50']]) || {}).collector || [];
  if (collectors.length === 0) {
    throw new Error('La planta ' + pid + ' no tiene colectores');
  }
  const pn = collectors[0].pn;
  const devs = (signedCall(cfg, 'queryCollectorDevices', [['pn', pn]]) || {}).dev || [];
  if (devs.length === 0) {
    throw new Error('El colector ' + pn + ' no tiene dispositivos');
  }
  const dev = devs[0];
  log.info('DessMonitor: plantas=' + plants.length + ' colectores=' + collectors.length + ' dispositivos=' + devs.length +
    '; usando planta ' + pid + ', colector ' + pn + ', devcode ' + dev.devcode + ', devaddr ' + dev.devaddr);
  return { pid: pid, pn: pn, devcode: dev.devcode, devaddr: dev.devaddr, sn: dev.sn };
}

// Flatten whatever shape queryDeviceLastData returns into [{title, val, unit}]
function collectPoints(node, out) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectPoints(n, out));
  } else if (node && typeof node === 'object') {
    if (node.title !== undefined && node.val !== undefined) {
      out.push({ title: String(node.title).trim(), val: node.val, unit: node.unit || '' });
    } else {
      Object.values(node).forEach((n) => collectPoints(n, out));
    }
  }
  return out;
}

function findPoint(points, titles) {
  for (const t of titles) {
    const p = points.find((x) => x.title.toLowerCase() === t.toLowerCase());
    if (p && p.val !== '' && p.val !== null) {
      return p;
    }
  }
  return null;
}

function update(itemName, point) {
  const item = items.getItem(itemName, true);
  if (!item || !point) {
    return;
  }
  const num = parseFloat(point.val);
  if (item.type.startsWith('Number') && !isNaN(num)) {
    const unit = String(point.unit).trim();
    item.postUpdate(KNOWN_UNITS.includes(unit) ? num + ' ' + unit : String(num));
  } else {
    item.postUpdate(String(point.val));
  }
}

// The items file may load after this script, so tolerate missing items
function setStatus(text) {
  const item = items.getItem('Energia_ApiEstado', true);
  if (item) {
    item.postUpdate(text);
  }
}

// A reading older than this is considered frozen (datalogger not uploading)
const DATOS_VIEJOS_MIN = 15;
let avisoViejos = false;

function poll() {
  const cfg = loadConfig();
  if (!cfg || !cfg.usuario || !cfg.passwordSha1) {
    setStatus('Sin credenciales: ejecutar configurar-dessmonitor.ps1');
    return;
  }
  try {
    if (!device) {
      device = discoverDevice(cfg);
    }
    const dat = signedCall(cfg, 'queryDeviceLastData', [
      ['i18n', 'en'], ['pn', device.pn], ['devcode', device.devcode], ['devaddr', device.devaddr], ['sn', device.sn],
    ]);
    const points = collectPoints(dat, []);
    if (points.length === 0) {
      throw new Error('queryDeviceLastData sin datos');
    }
    if (!titlesLogged) {
      log.info('DessMonitor: ' + points.length + ' datos disponibles: ' +
        points.map((p) => p.title + '=' + p.val + (p.unit ? ' ' + p.unit : '')).join(' | '));
      titlesLogged = true;
    }

    // The cloud keeps answering with the last reading when the datalogger stops uploading:
    // use the inverter's own timestamp, and don't repost a frozen reading as if it were new
    const ts = findPoint(points, ['Timestamp']);
    let tsDatos = null;
    if (ts) {
      try {
        tsDatos = time.LocalDateTime.parse(String(ts.val).trim().replace(' ', 'T')).atZone(time.ZoneId.systemDefault());
      } catch (e) {
        tsDatos = null;
      }
    }
    if (tsDatos) {
      const edadMin = time.Duration.between(tsDatos, time.ZonedDateTime.now()).toMinutes();
      if (edadMin > DATOS_VIEJOS_MIN) {
        const ult = items.getItem('Energia_UltimaLectura');
        if (String(ult.state) === 'NULL' || !time.toZDT(ult.state).isEqual(tsDatos)) {
          ult.postUpdate(tsDatos);
        }
        const hhmm = String(ts.val).trim().substring(11, 16);
        setStatus('Sin datos nuevos desde las ' + hhmm + ' (el datalogger no envía a la nube)');
        if (!avisoViejos) {
          log.warn('DessMonitor: la última lectura del inversor es de ' + ts.val + ' (' + edadMin + ' min); el datalogger dejó de enviar datos');
          avisoViejos = true;
        }
        return;
      }
      if (avisoViejos) {
        log.info('DessMonitor: datos del inversor actualizados de nuevo (' + ts.val + ')');
        avisoViejos = false;
      }
    }

    const map = Object.assign({}, DEFAULT_MAP, cfg.mapa || {});
    for (const [itemName, titles] of Object.entries(map)) {
      update(itemName, findPoint(points, titles));
    }
    // This inverter reports no watts: derive them
    const vbat = parseFloat((findPoint(points, map.Bateria_Voltaje) || {}).val);
    const ipv = parseFloat((findPoint(points, map.Solar_Corriente) || {}).val);
    if (!isNaN(vbat) && !isNaN(ipv)) {
      items.getItem('Solar_Potencia').postUpdate(Math.round(vbat * ipv) + ' W');
    }
    const loadPct = parseFloat((findPoint(points, map.Casa_CargaPct) || {}).val);
    if (cfg.potenciaNominalW > 0 && !isNaN(loadPct)) {
      items.getItem('Casa_Consumo').postUpdate(Math.round(cfg.potenciaNominalW * loadPct / 100) + ' W');
    }

    const alarms = ALARM_TITLES
      .map((t) => findPoint(points, [t]))
      .filter((p) => p && !['NO', '--', ''].includes(String(p.val).trim().toUpperCase()))
      .map((p) => p.title);
    items.getItem('Inversor_Alarma').postUpdate(alarms.length ? alarms.join(', ') : 'Sin alarmas');

    const snapshot = {};
    points.forEach((p) => { snapshot[p.title] = p.val + (p.unit ? ' ' + p.unit : ''); });
    items.getItem('Energia_Datos').postUpdate(JSON.stringify(snapshot));
    items.getItem('Energia_UltimaLectura').postUpdate(tsDatos || time.ZonedDateTime.now());
    setStatus('OK');
  } catch (e) {
    // Force a fresh login and device lookup on the next run
    session = { token: null, secret: null, expiresAt: 0 };
    device = null;
    log.warn('DessMonitor: ' + e.message);
    setStatus('Error: ' + e.message);
  }
}

rules.JSRule({
  name: 'DessMonitor: leer inversor',
  description: 'Consulta la nube DessMonitor cada 2 minutos y actualiza los ítems de energía',
  triggers: [triggers.GenericCronTrigger('0 0/2 * * * ?'), triggers.SystemStartlevelTrigger(100)],
  execute: poll,
});

// Run once right after the file is (re)loaded
poll();
