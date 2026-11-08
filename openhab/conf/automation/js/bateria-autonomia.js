/*
 * Autonomía estimada de la batería
 *
 * horas = (Bateria_SOC - Bateria_SocMinimo) x Bateria_WhPorPct / consumo neto
 * El consumo neto es el promedio de los últimos 30 min de Casa_Consumo menos Solar_Potencia,
 * para que una luz encendida un momento no haga saltar la cifra.
 * Parámetros editables en conf/items/bateria.items (valores por defecto abajo).
 */

const log = console;

const DEFAULTS = {
  Bateria_WhPorPct: '45 Wh',
  Bateria_SocMinimo: '15 %',
};

const MINUTOS_PROMEDIO = 30;

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

// Promedio en InfluxDB de los últimos minutos; si no hay datos, el valor actual
function promedio(itemName) {
  try {
    const desde = time.toZDT().minusMinutes(MINUTOS_PROMEDIO);
    const r = items.getItem(itemName).persistence.averageSince(desde, 'influxdb');
    const v = r === null || r === undefined ? NaN : parseFloat(r.numericState !== undefined ? r.numericState : r.state !== undefined ? r.state : r);
    if (!isNaN(v)) {
      return v;
    }
  } catch (e) {
    log.debug('Autonomía: sin promedio de ' + itemName + ': ' + e.message);
  }
  return num(itemName);
}

function onBattery() {
  const mode = items.getItem('Inversor_Modo', true);
  return !mode || isUnset(mode) || /inverter|battery/i.test(String(mode.state));
}

function formatoHoras(h) {
  const total = Math.round(h * 60);
  const horas = Math.floor(total / 60);
  const minutos = total % 60;
  return horas > 0 ? horas + ' h ' + minutos + ' min' : minutos + ' min';
}

function publicar(texto, horas) {
  items.getItem('Bateria_Autonomia').postUpdate(texto);
  items.getItem('Bateria_AutonomiaH').postUpdate(horas === null ? 'UNDEF' : horas.toFixed(2) + ' h');
}

function calcular() {
  const soc = num('Bateria_SOC');
  const minimo = num('Bateria_SocMinimo');
  const whPorPct = num('Bateria_WhPorPct');
  if (isNaN(soc) || isNaN(minimo) || isNaN(whPorPct)) {
    publicar('Sin datos', null);
    return;
  }
  items.getItem('Bateria_Disponible').postUpdate(Math.round(Math.max(0, soc - minimo) * whPorPct) + ' Wh');
  if (!onBattery()) {
    publicar('Usando la red eléctrica', null);
    return;
  }
  const neto = promedio('Casa_Consumo') - (promedio('Solar_Potencia') || 0);
  if (isNaN(neto)) {
    publicar('Sin datos', null);
    return;
  }
  items.getItem('Bateria_ConsumoNeto').postUpdate(Math.round(neto) + ' W');
  if (neto <= 10) {
    publicar('Cargando: el sol cubre el consumo', null);
    return;
  }
  const horas = Math.max(0, soc - minimo) * whPorPct / neto;
  publicar('≈ ' + formatoHoras(horas) + ' (con ' + Math.round(neto) + ' W)', horas);
}

rules.JSRule({
  name: 'Batería: autonomía estimada',
  description: 'Horas que quedan de batería según el consumo de los últimos 30 min',
  triggers: [
    triggers.ItemStateChangeTrigger('Bateria_SOC'),
    triggers.ItemStateChangeTrigger('Inversor_Modo'),
    triggers.ItemStateChangeTrigger('Bateria_WhPorPct'),
    triggers.ItemStateChangeTrigger('Bateria_SocMinimo'),
    triggers.GenericCronTrigger('0 */2 * * * ?'),
    triggers.SystemStartlevelTrigger(100),
  ],
  execute: () => {
    for (const [name, value] of Object.entries(DEFAULTS)) {
      if (isUnset(items.getItem(name))) {
        items.getItem(name).postUpdate(value);
      }
    }
    calcular();
  },
});

// Primer cálculo al cargar el archivo, sin esperar al cron
setTimeout(() => {
  for (const [name, value] of Object.entries(DEFAULTS)) {
    if (isUnset(items.getItem(name))) {
      items.getItem(name).postUpdate(value);
    }
  }
  setTimeout(calcular, 2000);
}, 3000);
