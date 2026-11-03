/*
 * Ahorro automático de energía según la batería (fase 4)
 *
 * Escalonado, solo cuando la casa funciona con batería (Inversor_Modo = "Inverter mode"):
 *   - Batería <= Ahorro_UmbralBajo:    luces LCN regulables limitadas a Ahorro_NivelAtenuado
 *   - Batería <= Ahorro_UmbralCritico: todas las cargas de la lista se apagan
 *   - Vuelve a "Normal" cuando la batería sube Ahorro_Histeresis por encima del umbral bajo.
 *     Las luces no se vuelven a encender solas.
 * Parámetros editables en el grupo gAhorro (conf/items/ahorro.items).
 */

const log = console;

// Cargas elegidas por el usuario (2026-10-31)
const CARGAS = [
  { item: 'Module_5_ENTRADA_Output_2', nombre: 'Laterales Comedor', regulable: true },
  { item: 'Module_9_SALA_Output_2', nombre: 'Luz Central Sala', regulable: true },
  { item: 'Module_9_SALA_Output_1', nombre: 'Luz Lateral Sala', regulable: true },
  { item: 'Module_6_COCINA_Output_2', nombre: 'Luz Cocina', regulable: true },
  { item: 'Module_7_COMEDOR_Output_2', nombre: 'Luz Lateral Comedor', regulable: true },
  { item: 'Module_102_CUARTO_PRINCIPAL_Output_1', nombre: 'Luz Central Dormitorio', regulable: true },
  { item: 'Interruptor_Alejandro_switch_1', nombre: 'Luz Central Alejandro', regulable: false },
  { item: 'Interruptor_Julian_switch_1', nombre: 'Luz Central Julian', regulable: false },
];

const DEFAULTS = {
  Ahorro_Auto: 'ON',
  Ahorro_Simulacion: 'OFF',
  Ahorro_Notificar: 'ON',
  Ahorro_UmbralBajo: '30 %',
  Ahorro_UmbralCritico: '20 %',
  Ahorro_Histeresis: '5 %',
  Ahorro_NivelAtenuado: '40 %',
};

const API_ERROR_MINUTES = 15;

function isUnset(item) {
  return item.isUninitialized || item.state === 'NULL' || item.state === 'UNDEF';
}

function num(itemName) {
  const item = items.getItem(itemName, true);
  if (!item || isUnset(item)) {
    return NaN;
  }
  return parseFloat(item.state);
}

function notify(text) {
  log.info('Ahorro: ' + text);
  if (items.getItem('Ahorro_Notificar').state === 'ON') {
    try {
      actions.NotificationAction.sendBroadcastNotification(text);
    } catch (e) {
      log.warn('Ahorro: no se pudo enviar la notificación: ' + e.message);
    }
  }
}

function currentSoc() {
  const test = num('Ahorro_SocPrueba');
  return isNaN(test) ? num('Bateria_SOC') : test;
}

function onBattery() {
  const mode = items.getItem('Inversor_Modo', true);
  // Unknown mode: assume battery so protection still applies
  return !mode || isUnset(mode) || /inverter|battery/i.test(String(mode.state));
}

function nextState(previous, soc, low, critical, margin) {
  if (soc <= critical) {
    return 'Crítico';
  }
  if (previous === 'Crítico' && soc < critical + margin) {
    return 'Crítico';
  }
  if (soc <= low) {
    return 'Bajo';
  }
  if (previous !== 'Normal' && soc < low + margin) {
    return previous === 'Crítico' ? 'Bajo' : previous;
  }
  return 'Normal';
}

// Returns the list of actions taken (or that would be taken in simulation)
function enforce(state) {
  const simulate = items.getItem('Ahorro_Simulacion').state === 'ON';
  const dimLevel = num('Ahorro_NivelAtenuado');
  const done = [];
  for (const c of CARGAS) {
    const item = items.getItem(c.item, true);
    if (!item || isUnset(item)) {
      continue;
    }
    let command = null;
    if (state === 'Crítico') {
      const on = c.regulable ? parseFloat(item.state) > 0 : item.state === 'ON';
      if (on) {
        command = c.regulable ? '0' : 'OFF';
      }
    } else if (state === 'Bajo' && c.regulable && parseFloat(item.state) > dimLevel) {
      command = String(Math.round(dimLevel));
    }
    if (command !== null) {
      done.push(c.nombre + ' → ' + (command === 'OFF' || command === '0' ? 'apagada' : command + ' %'));
      if (!simulate) {
        item.sendCommand(command);
      }
    }
  }
  if (done.length > 0) {
    const text = (simulate ? '[Simulación] ' : '') + done.join(', ');
    items.getItem('Ahorro_UltimaAccion').postUpdate(text);
    log.info('Ahorro (' + state + '): ' + text);
  }
  return done;
}

function evaluate() {
  if (items.getItem('Ahorro_Auto').state !== 'ON') {
    items.getItem('Ahorro_Estado').postUpdate('Desactivado');
    return;
  }
  const soc = currentSoc();
  const low = num('Ahorro_UmbralBajo');
  const critical = num('Ahorro_UmbralCritico');
  const margin = num('Ahorro_Histeresis');
  if ([soc, low, critical, margin].some(isNaN)) {
    return;
  }
  const estadoItem = items.getItem('Ahorro_Estado');
  const prevRaw = isUnset(estadoItem) ? 'Normal' : String(estadoItem.state);
  const previous = prevRaw.startsWith('Crítico') ? 'Crítico' : prevRaw.startsWith('Bajo') ? 'Bajo' : 'Normal';

  if (!onBattery()) {
    if (previous !== 'Normal') {
      notify('Hay red eléctrica: ahorro en pausa (batería ' + Math.round(soc) + ' %).');
    }
    estadoItem.postUpdate('Normal (con red)');
    return;
  }

  const state = nextState(previous, soc, low, critical, margin);
  if (state !== previous) {
    const done = enforce(state);
    const msgs = {
      Bajo: 'Batería baja (' + Math.round(soc) + ' %): luces limitadas al ' + Math.round(num('Ahorro_NivelAtenuado')) + ' %.',
      Crítico: 'Batería crítica (' + Math.round(soc) + ' %): luces seleccionadas apagadas.',
      Normal: 'Batería recuperada (' + Math.round(soc) + ' %): ahorro desactivado.',
    };
    notify(msgs[state] + (done.length ? ' ' + done.length + ' cargas ajustadas.' : ''));
  } else if (state !== 'Normal') {
    // Keep the limit if someone turns a light back up while in saving mode
    enforce(state);
  }
  estadoItem.postUpdate(state);
}

// --- Parameter defaults (only when empty; persisted values win) ---
for (const [name, value] of Object.entries(DEFAULTS)) {
  const item = items.getItem(name, true);
  if (item && isUnset(item)) {
    item.postUpdate(value);
  }
}

rules.JSRule({
  name: 'Ahorro: evaluar batería',
  description: 'Limita o apaga cargas según la carga de la batería cuando se funciona con batería',
  triggers: [
    triggers.ItemStateChangeTrigger('Bateria_SOC'),
    triggers.ItemStateChangeTrigger('Inversor_Modo'),
    triggers.ItemStateChangeTrigger('Ahorro_Auto'),
    triggers.ItemStateChangeTrigger('Ahorro_SocPrueba'),
    triggers.ItemStateChangeTrigger('Ahorro_UmbralBajo'),
    triggers.ItemStateChangeTrigger('Ahorro_UmbralCritico'),
    triggers.ItemStateChangeTrigger('Ahorro_NivelAtenuado'),
    triggers.ItemStateUpdateTrigger('Energia_UltimaLectura'),
  ],
  execute: evaluate,
});

rules.JSRule({
  name: 'Ahorro: avisar alarmas del inversor',
  triggers: [triggers.ItemStateChangeTrigger('Inversor_Alarma')],
  execute: (event) => {
    if (event.newState && event.newState !== 'Sin alarmas') {
      notify('Alarma del inversor: ' + event.newState);
    } else if (event.oldState && event.oldState !== 'NULL') {
      notify('Alarmas del inversor despejadas.');
    }
  },
});

let apiAlertSent = false;

rules.JSRule({
  name: 'Ahorro: vigilar conexión DessMonitor',
  triggers: [triggers.GenericCronTrigger('0 */5 * * * ?')],
  execute: () => {
    const last = items.getItem('Energia_UltimaLectura');
    if (isUnset(last)) {
      return;
    }
    const minutes = time.Duration.between(time.toZDT(last.state), time.ZonedDateTime.now()).toMinutes();
    if (minutes >= API_ERROR_MINUTES && !apiAlertSent) {
      notify('Sin datos del inversor desde hace ' + minutes + ' min (' + items.getItem('Energia_ApiEstado').state + ').');
      apiAlertSent = true;
    } else if (minutes < API_ERROR_MINUTES && apiAlertSent) {
      notify('Datos del inversor recuperados.');
      apiAlertSent = false;
    }
  },
});
