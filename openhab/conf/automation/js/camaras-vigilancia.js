/*
 * Vigilancia de las fotos de las cámaras
 *
 * Con snapshotUrl=ffmpeg, el binding ipcamera puede quedarse sirviendo siempre la misma foto
 * (el ffmpeg interno se cuelga) mientras la cámara sigue ONLINE. Pasó la noche del 5 al 6 de
 * noviembre de 2026. Esta regla lee la foto local cada minuto; si no cambia en
 * MINUTOS_CONGELADA minutos, desactiva y reactiva el Thing, que arranca un ffmpeg nuevo.
 * Solo lee ipcamera.jpg en el servidor: no abre el vídeo de la cámara.
 */

const log = console;

const CAMARAS = {
  'ipcamera:amcrest:nvr_ch4': 'nvr_ch4',
  'ipcamera:amcrest:nvr_ch3': 'nvr_ch3',
  'ipcamera:amcrest:5a78ecb7e8': '5a78ecb7e8',
};

const MINUTOS_CONGELADA = 3;
const MINUTOS_ENTRE_REINICIOS = 15;

const ultimaFoto = {};
const minutosIgual = {};
const ultimoReinicio = {};

function revisar(uid, id) {
  const thing = things.getThing(uid);
  if (!thing || !thing.isEnabled || thing.status !== 'ONLINE') {
    minutosIgual[uid] = 0;
    return;
  }
  let foto = null;
  try {
    foto = actions.HTTP.sendHttpGetRequest('http://127.0.0.1:8080/ipcamera/' + id + '/ipcamera.jpg', 5000);
  } catch (e) {
    foto = null;
  }
  if (foto === null || foto === undefined) {
    return;
  }
  if (foto === ultimaFoto[uid]) {
    minutosIgual[uid] = (minutosIgual[uid] || 0) + 1;
  } else {
    minutosIgual[uid] = 0;
    ultimaFoto[uid] = foto;
  }
  if (minutosIgual[uid] < MINUTOS_CONGELADA) {
    return;
  }
  const ahora = Date.now();
  if (ultimoReinicio[uid] && ahora - ultimoReinicio[uid] < MINUTOS_ENTRE_REINICIOS * 60000) {
    return;
  }
  log.warn('Cámara ' + id + ': la foto no cambia desde hace ' + minutosIgual[uid] + ' min, reinicio el Thing');
  ultimoReinicio[uid] = ahora;
  minutosIgual[uid] = 0;
  thing.setEnabled(false);
  setTimeout(() => things.getThing(uid).setEnabled(true), 5000);
}

rules.JSRule({
  name: 'Cámaras: reiniciar si la foto se congela',
  description: 'Desactiva y reactiva la cámara si su foto no cambia en ' + MINUTOS_CONGELADA + ' min',
  triggers: [triggers.GenericCronTrigger('30 * * * * ?')],
  execute: () => {
    for (const [uid, id] of Object.entries(CAMARAS)) {
      revisar(uid, id);
    }
  },
});
