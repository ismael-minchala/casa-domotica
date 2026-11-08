/*
 * Apagado general y monitor de luces encendidas
 *
 * Casa_ApagarTodo:
 *   - comando ON (botón de la app): apaga todas las luces y los televisores encendidos
 *   - comando OFF: simulación, solo registra qué haría (para probar sin apagar nada)
 * No toca la sirena ni las persianas.
 * Items en conf/items/casa.items.
 */

const log = console;

const LUCES = [
  { item: 'Module_5_ENTRADA_Output_1', nombre: 'Escalera baja', thing: 'lcn:module:LCN-PCHK:S000M005' },
  { item: 'Module_5_ENTRADA_Output_2', nombre: 'Laterales comedor', thing: 'lcn:module:LCN-PCHK:S000M005' },
  { item: 'Garaje_Luz', nombre: 'Garaje', thing: 'tuya:tuyaDevice:72016014bcddc2a368bf' },
  { item: 'Module_6_COCINA_Output_2', nombre: 'Luz cocina', thing: 'lcn:module:LCN-PCHK:S000M006' },
  { item: 'Module_6_COCINA_Output_1', nombre: 'Leds cocina', thing: 'lcn:module:LCN-PCHK:S000M006' },
  { item: 'Module_7_COMEDOR_Output_1', nombre: 'Comedor central', thing: 'lcn:module:LCN-PCHK:S000M007' },
  { item: 'Module_7_COMEDOR_Output_2', nombre: 'Comedor lateral', thing: 'lcn:module:LCN-PCHK:S000M007' },
  { item: 'Module_9_SALA_Output_2', nombre: 'Sala central', thing: 'lcn:module:LCN-PCHK:S000M009' },
  { item: 'Module_9_SALA_Output_1', nombre: 'Sala lateral', thing: 'lcn:module:LCN-PCHK:S000M009' },
  { item: 'Module_102_CUARTO_PRINCIPAL_Output_1', nombre: 'Dormitorio central', thing: 'lcn:module:LCN-PCHK:S000M102' },
  { item: 'Module_102_CUARTO_PRINCIPAL_Output_2', nombre: 'Dormitorio lateral', thing: 'lcn:module:LCN-PCHK:S000M102' },
  { item: 'Panel_Luz', nombre: 'Panel', thing: 'tuya:tuyaDevice:022003606001947348b6' },
  { item: 'Interruptor_Julian_switch_1', nombre: 'Julián central', thing: 'tuya:tuyaDevice:eb1fa459e0e3dc1d98fxft' },
  { item: 'Interruptor_Julian_switch_2', nombre: 'Julián lateral', thing: 'tuya:tuyaDevice:eb1fa459e0e3dc1d98fxft' },
  { item: 'Interruptor_Alejandro_switch_1', nombre: 'Alejandro central', thing: 'tuya:tuyaDevice:ebaa9a4c836c2261d0aobc' },
  { item: 'Interruptor_Alejandro_switch_2', nombre: 'Alejandro lateral', thing: 'tuya:tuyaDevice:ebaa9a4c836c2261d0aobc' },
];

// Solo se apagan si están encendidos: el comando de energía podría encender uno apagado
const TELEVISORES = ['TV_Sala_Encendido', 'MIBOX3_Encendido', 'TV_Ale_Encendido'];

const SEGUNDOS_VERIFICACION = 20;

function encendida(luz) {
  const state = String(items.getItem(luz.item).state);
  return state === 'ON' || parseFloat(state) > 0;
}

function enLinea(luz) {
  const thing = things.getThing(luz.thing);
  return !!thing && thing.status === 'ONLINE';
}

function publicar(itemName, value) {
  const item = items.getItem(itemName);
  if (String(item.state) !== String(value)) {
    item.postUpdate(String(value));
  }
}

function resumen() {
  const conectadas = LUCES.filter(enLinea);
  return {
    encendidas: conectadas.filter(encendida).map((luz) => luz.nombre),
    sinConexion: LUCES.filter((luz) => !enLinea(luz)).map((luz) => luz.nombre),
  };
}

function actualizarMonitor() {
  const r = resumen();
  publicar('Luces_Encendidas', r.encendidas.length);
  publicar('Luces_Lista', r.encendidas.length ? r.encendidas.join(', ') : 'Ninguna');
  publicar('Luces_SinConexion', r.sinConexion.length ? r.sinConexion.join(', ') : 'Ninguna');
  return r;
}

function horaActual() {
  return time.ZonedDateTime.now().format(time.DateTimeFormatter.ofPattern('HH:mm'));
}

function apagarTodo(simulacion) {
  const televisores = TELEVISORES.filter((name) => items.getItem(name).state === 'ON');
  const antes = resumen();

  if (simulacion) {
    const texto = 'Simulación: apagaría ' + LUCES.length + ' luces (encendidas: ' + (antes.encendidas.join(', ') || 'ninguna') + '), televisores: ' + (televisores.join(', ') || 'ninguno');
    log.info('Apagado general: ' + texto);
    items.getItem('Casa_ApagadoEstado').postUpdate(horaActual() + ' · ' + texto);
    return;
  }

  log.info('Apagado general: encendidas antes: ' + (antes.encendidas.join(', ') || 'ninguna'));
  LUCES.forEach((luz) => items.getItem(luz.item).sendCommand('OFF'));
  televisores.forEach((name) => items.getItem(name).sendCommand('OFF'));
  const hora = horaActual();
  items.getItem('Casa_ApagadoEstado').postUpdate(hora + ' · apagando...');

  // Confirmar con el estado real, que llega de los módulos unos segundos después
  setTimeout(() => {
    const r = actualizarMonitor();
    let texto = hora + ' · ' + (r.encendidas.length ? 'siguen encendidas: ' + r.encendidas.join(', ') : 'todo apagado');
    if (r.sinConexion.length) {
      texto += ' · sin conexión: ' + r.sinConexion.join(', ');
    }
    log.info('Apagado general: ' + texto);
    items.getItem('Casa_ApagadoEstado').postUpdate(texto);
  }, SEGUNDOS_VERIFICACION * 1000);
}

rules.JSRule({
  name: 'Casa: apagado general',
  description: 'Apaga todas las luces y los televisores encendidos',
  triggers: [triggers.ItemCommandTrigger('Casa_ApagarTodo')],
  execute: (event) => apagarTodo(event.receivedCommand !== 'ON'),
});

rules.JSRule({
  name: 'Casa: monitor de luces',
  description: 'Cuenta las luces encendidas y las que no tienen conexión',
  triggers: [
    ...LUCES.map((luz) => triggers.ItemStateChangeTrigger(luz.item)),
    triggers.GenericCronTrigger('0 * * * * ?'),
    triggers.SystemStartlevelTrigger(100),
  ],
  execute: actualizarMonitor,
});
