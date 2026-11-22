/*
 * Cálculos del sistema fotovoltaico aislado de la casa: ejemplo independiente
 *
 * Reúne en un solo archivo, sin dependencias, las fórmulas que usa openHAB:
 *   - dessmonitor.js         potencia solar y consumo derivados de los datos del inversor
 *   - energia-diaria.html    energía por día (kWh) integrando la potencia con el trapecio
 *   - bateria-autonomia.js   autonomía estimada de la batería
 *   - ahorro-energia.js      máquina de estados del ahorro automático (Normal / Bajo / Crítico)
 *   - dessmonitor.js         detección de lecturas congeladas
 * y añade algunos cálculos derivados (marcados como «extra») que no están en openHAB.
 *
 * Funciona en Node.js (>= 14) o en un navegador. Para ver el ejemplo con datos simulados:
 *     node ejemplos/calculos-fv.js
 * Para usarlo desde otra app:
 *     const fv = require('./calculos-fv.js');   // Node
 *     <script src="calculos-fv.js"></script>     // navegador: queda en window.CalculosFV
 *
 * Unidades: potencia en W, energía en Wh (kWh donde se indica), tiempo en ms (marcas de tiempo
 * Unix, como Date.now()) salvo que el nombre diga otra cosa, SOC en %.
 */

// ---------------------------------------------------------------------------------------------
// Parámetros del sistema (valores reales de la casa a noviembre de 2026)
// ---------------------------------------------------------------------------------------------
const SISTEMA = {
  potenciaNominalW: 3000,     // potencia nominal del inversor; el inversor informa la carga en %
  voltajeSistemaV: 24,        // banco de 2 baterías de 12 V en serie
  whPorPct: 45,               // energía por cada 1 % de SOC (medida en las noches del 1 al 4/11/2026)
  socMinimo: 15,              // % al que el inversor deja la batería y pasa a la red
  zonaHorariaMs: -5 * 3600e3, // Ecuador (UTC-5, sin horario de verano)
  huecoMaximoMs: 30 * 60e3,   // no integrar a través de huecos de datos más largos
  minutosPromedio: 30,        // ventana del promedio para la autonomía
  netoMinimoW: 10,            // por debajo de esto se considera que el sol cubre el consumo
  datosViejosMin: 15,         // una lectura más antigua se considera congelada
  ahorro: { umbralBajo: 30, umbralCritico: 20, histeresis: 5, nivelAtenuado: 40 },
};

const DIA_MS = 86400e3;

// ---------------------------------------------------------------------------------------------
// 1. Potencias instantáneas (el inversor no informa vatios; se derivan)
// ---------------------------------------------------------------------------------------------

/** Potencia que entrega el controlador solar: P = V_batería · I_carga. */
function potenciaSolar(voltajeBateriaV, corrienteCargaA) {
  return voltajeBateriaV * corrienteCargaA;
}

/**
 * Consumo de la casa a partir del % de carga del inversor: P = carga% / 100 · P_nominal.
 * Solo es válido con el inversor en «Inverter mode»: con red («Mains mode») informa 0 %.
 */
function consumoCasa(cargaPct, potenciaNominalW = SISTEMA.potenciaNominalW) {
  return (cargaPct / 100) * potenciaNominalW;
}

/** true si el inversor alimenta la casa desde la batería (modo desconocido = batería, por seguridad). */
function usandoBateria(modoInversor) {
  return !modoInversor || /inverter|battery/i.test(String(modoInversor));
}

// ---------------------------------------------------------------------------------------------
// 2. Energía: integración por el método del trapecio
// ---------------------------------------------------------------------------------------------

/** Índice del día local de una marca de tiempo (días desde 1970 en hora local). */
function diaLocal(t, zona = SISTEMA.zonaHorariaMs) {
  return Math.floor((t + zona) / DIA_MS);
}

/** Marca de tiempo UTC de la medianoche local que inicia el día `d`. */
function inicioDia(d, zona = SISTEMA.zonaHorariaMs) {
  return d * DIA_MS - zona;
}

/** Fecha 'AAAA-MM-DD' del día local `d`. */
function fechaDia(d) {
  return new Date(d * DIA_MS).toISOString().slice(0, 10);
}

/**
 * Energía (Wh) de una serie de potencia [{t, w}] ordenada por tiempo:
 *   E = Σ (P_k + P_k+1) / 2 · (t_k+1 − t_k)
 * Los tramos más largos que `huecoMaximoMs` se ignoran (faltan datos, no se inventan).
 */
function energiaWh(serie, huecoMaximoMs = SISTEMA.huecoMaximoMs) {
  let wh = 0;
  for (let i = 1; i < serie.length; i++) {
    const dt = serie[i].t - serie[i - 1].t;
    if (dt <= 0 || dt > huecoMaximoMs) continue;
    wh += ((serie[i - 1].w + serie[i].w) / 2) * (dt / 3600e3);
  }
  return wh;
}

/**
 * Energía por día local en kWh: { 'AAAA-MM-DD': kWh }.
 * Un tramo que cruza la medianoche se parte, interpolando la potencia en el corte,
 * para que cada parte cuente en su día (igual que energia-diaria.html y Grafana).
 */
function energiaPorDiaKWh(serie, opciones = {}) {
  const zona = opciones.zonaHorariaMs ?? SISTEMA.zonaHorariaMs;
  const hueco = opciones.huecoMaximoMs ?? SISTEMA.huecoMaximoMs;
  const porDia = {};
  for (let i = 1; i < serie.length; i++) {
    let t0 = serie[i - 1].t, w0 = serie[i - 1].w;
    const t1 = serie[i].t, w1 = serie[i].w;
    if (t1 <= t0 || t1 - t0 > hueco) continue;
    while (t0 < t1) {
      const d = diaLocal(t0, zona);
      const fin = Math.min(t1, inicioDia(d + 1, zona));
      const wFin = w0 + ((w1 - w0) * (fin - t0)) / (t1 - t0);
      const clave = fechaDia(d);
      porDia[clave] = (porDia[clave] || 0) + ((w0 + wFin) / 2) * ((fin - t0) / 3600e3) / 1000;
      t0 = fin;
      w0 = wFin;
    }
  }
  return porDia;
}

/**
 * Promedio ponderado por tiempo de una serie [{t, w}] en los últimos `minutos` antes de `ahora`
 * (equivale a averageSince de la persistencia de openHAB). Devuelve NaN si no hay datos.
 */
function promedioReciente(serie, minutos = SISTEMA.minutosPromedio, ahora = Date.now()) {
  const desde = ahora - minutos * 60e3;
  // el último punto anterior a la ventana define el valor al inicio de ella
  const tramo = serie.filter((p) => p.t >= desde && p.t <= ahora);
  const previo = serie.filter((p) => p.t < desde).pop();
  if (previo) tramo.unshift({ t: desde, w: previo.w });
  if (tramo.length === 0) return NaN;
  if (tramo.length === 1) return tramo[0].w;
  const fin = tramo[tramo.length - 1].t;
  return fin > tramo[0].t ? (energiaWh(tramo, Infinity) * 3600e3) / (fin - tramo[0].t) : tramo[0].w;
}

// ---------------------------------------------------------------------------------------------
// 3. Batería: energía disponible y autonomía
// ---------------------------------------------------------------------------------------------

/** Energía utilizable (Wh) hasta el mínimo del inversor: (SOC − SOC_mín) · Wh_por_%. */
function energiaDisponibleWh(soc, sistema = SISTEMA) {
  return Math.max(0, soc - sistema.socMinimo) * sistema.whPorPct;
}

/**
 * Autonomía estimada (igual que bateria-autonomia.js):
 *   horas = (SOC − SOC_mín) · Wh_por_% / (consumo_prom − solar_prom)
 * con consumo y solar promediados en los últimos 30 min para que una carga breve no haga saltar
 * la cifra. Devuelve { estado, horas, consumoNetoW, disponibleWh, texto }.
 *   estado: 'descargando' | 'cargando' | 'red' | 'sin-datos'
 */
function autonomia({ soc, consumoPromW, solarPromW = 0, modoInversor }, sistema = SISTEMA) {
  if ([soc, consumoPromW].some((v) => typeof v !== 'number' || isNaN(v))) {
    return { estado: 'sin-datos', horas: null, texto: 'Sin datos' };
  }
  const disponibleWh = energiaDisponibleWh(soc, sistema);
  if (!usandoBateria(modoInversor)) {
    return { estado: 'red', horas: null, disponibleWh, texto: 'Usando la red eléctrica' };
  }
  const consumoNetoW = consumoPromW - (solarPromW || 0);
  if (consumoNetoW <= sistema.netoMinimoW) {
    return { estado: 'cargando', horas: null, consumoNetoW, disponibleWh, texto: 'Cargando: el sol cubre el consumo' };
  }
  const horas = disponibleWh / consumoNetoW;
  return {
    estado: 'descargando',
    horas,
    consumoNetoW,
    disponibleWh,
    texto: '≈ ' + formatoHoras(horas) + ' (con ' + Math.round(consumoNetoW) + ' W)',
  };
}

/** 2.5 → '2 h 30 min'; 0.4 → '24 min'. */
function formatoHoras(h) {
  const total = Math.round(h * 60);
  const horas = Math.floor(total / 60);
  const minutos = total % 60;
  return horas > 0 ? horas + ' h ' + minutos + ' min' : minutos + ' min';
}

/**
 * Calibración de Wh por 1 % (así se obtuvo el valor de 45 Wh): durante una noche sin sol y sin red,
 * la energía consumida dividida entre los puntos de SOC que bajó la batería.
 *   Wh_por_% = ∫ (consumo − solar) dt / (SOC_inicio − SOC_fin)
 * `consumo` y `solar` son series [{t, w}] del mismo intervalo. Repetir varias noches y promediar.
 */
function calibrarWhPorPct({ consumo, solar = [], socInicio, socFin }) {
  const caida = socInicio - socFin;
  if (!(caida > 0)) return NaN;
  return (energiaWh(consumo) - energiaWh(solar)) / caida;
}

/** Capacidad útil total (Wh) entre el 100 % y el mínimo del inversor. */
function capacidadUtilWh(sistema = SISTEMA) {
  return (100 - sistema.socMinimo) * sistema.whPorPct;
}

/** Extra: capacidad equivalente en Ah del banco (Wh por % · 100 / V). */
function capacidadEquivalenteAh(sistema = SISTEMA) {
  return (sistema.whPorPct * 100) / sistema.voltajeSistemaV;
}

/** Extra: tiempo estimado hasta el 100 % cuando el sol supera al consumo (horas, o null). */
function tiempoHastaLlenaH({ soc, consumoPromW, solarPromW }, sistema = SISTEMA) {
  const excedenteW = solarPromW - consumoPromW;
  if (!(excedenteW > sistema.netoMinimoW) || soc >= 100) return null;
  return ((100 - soc) * sistema.whPorPct) / excedenteW;
}

// ---------------------------------------------------------------------------------------------
// 4. Ahorro automático: máquina de estados con histéresis (igual que ahorro-energia.js)
// ---------------------------------------------------------------------------------------------

/**
 * Estado siguiente a partir del anterior y del SOC:
 *   Normal → Bajo     si SOC ≤ umbralBajo (luces regulables limitadas a nivelAtenuado)
 *   → Crítico         si SOC ≤ umbralCritico (se apagan las cargas)
 *   Crítico → Bajo    cuando SOC ≥ umbralCritico + histéresis
 *   Bajo → Normal     cuando SOC ≥ umbralBajo + histéresis
 * Con red eléctrica la regla real vuelve a «Normal» (no actúa); aquí se pasa `usandoBateria`.
 */
function estadoAhorro(anterior, soc, { umbralBajo, umbralCritico, histeresis } = SISTEMA.ahorro, enBateria = true) {
  if (!enBateria) return 'Normal';
  if (soc <= umbralCritico) return 'Crítico';
  if (anterior === 'Crítico' && soc < umbralCritico + histeresis) return 'Crítico';
  if (soc <= umbralBajo) return 'Bajo';
  if (anterior !== 'Normal' && soc < umbralBajo + histeresis) return 'Bajo';
  return 'Normal';
}

// ---------------------------------------------------------------------------------------------
// 5. Calidad de los datos
// ---------------------------------------------------------------------------------------------

/**
 * Una lectura es vieja (el datalogger dejó de subir datos y la nube repite la última) si su marca de
 * tiempo propia tiene más de `datosViejosMin` minutos. Devuelve { vieja, edadMin }.
 */
function lecturaVieja(tLectura, ahora = Date.now(), maxMin = SISTEMA.datosViejosMin) {
  const edadMin = Math.floor((ahora - tLectura) / 60e3);
  return { vieja: edadMin > maxMin, edadMin };
}

// ---------------------------------------------------------------------------------------------
// 6. Extras: indicadores diarios
// ---------------------------------------------------------------------------------------------

/**
 * Resumen de un día con series de solar y consumo [{t, w}] (deben cubrir solo ese día):
 *   generadaKWh, consumidaKWh, balanceKWh (generada − consumida),
 *   autoconsumoKWh: parte del consumo cubierta directamente por el sol en cada instante,
 *   coberturaSolarPct: autoconsumo / consumo, potencias pico,
 *   horasSolPico: generada / potencia FV instalada (solo si se indica `potenciaFVInstaladaW`).
 */
function resumenDiario(solar, consumo, potenciaFVInstaladaW) {
  const generadaKWh = energiaWh(solar) / 1000;
  const consumidaKWh = energiaWh(consumo) / 1000;
  // autoconsumo directo: min(solar, consumo) en los instantes del consumo
  const directo = consumo.map((p) => ({ t: p.t, w: Math.min(p.w, valorEn(solar, p.t)) }));
  const autoconsumoKWh = energiaWh(directo) / 1000;
  return {
    generadaKWh,
    consumidaKWh,
    balanceKWh: generadaKWh - consumidaKWh,
    autoconsumoKWh,
    coberturaSolarPct: consumidaKWh > 0 ? (100 * autoconsumoKWh) / consumidaKWh : null,
    picoSolarW: Math.max(0, ...solar.map((p) => p.w)),
    picoConsumoW: Math.max(0, ...consumo.map((p) => p.w)),
    horasSolPico: potenciaFVInstaladaW ? (generadaKWh * 1000) / potenciaFVInstaladaW : null,
  };
}

/** Valor interpolado linealmente de una serie [{t, w}] en el instante t (0 fuera de rango). */
function valorEn(serie, t) {
  for (let i = 1; i < serie.length; i++) {
    const a = serie[i - 1], b = serie[i];
    if (t >= a.t && t <= b.t) return b.t === a.t ? a.w : a.w + ((b.w - a.w) * (t - a.t)) / (b.t - a.t);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Exportación
// ---------------------------------------------------------------------------------------------
const CalculosFV = {
  SISTEMA,
  potenciaSolar, consumoCasa, usandoBateria,
  diaLocal, inicioDia, fechaDia, energiaWh, energiaPorDiaKWh, promedioReciente,
  energiaDisponibleWh, autonomia, formatoHoras, calibrarWhPorPct,
  capacidadUtilWh, capacidadEquivalenteAh, tiempoHastaLlenaH,
  estadoAhorro, lecturaVieja, resumenDiario, valorEn,
};
if (typeof module !== 'undefined' && module.exports) module.exports = CalculosFV;
if (typeof window !== 'undefined') window.CalculosFV = CalculosFV;

// ---------------------------------------------------------------------------------------------
// Ejemplo con datos simulados (solo al ejecutar `node calculos-fv.js`)
// ---------------------------------------------------------------------------------------------
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const L = (s) => console.log(s);
  const r1 = (x) => Math.round(x * 10) / 10;

  // Un día (1/11/2026, hora local) con una lectura cada 2 minutos, como DessMonitor
  const medianoche = inicioDia(diaLocal(Date.UTC(2026, 10, 1, 12)));
  const solar = [], consumo = [];
  for (let t = medianoche; t <= medianoche + DIA_MS; t += 2 * 60e3) {
    const h = (t - medianoche) / 3600e3; // hora local con decimales
    // sol entre 6:00 y 18:00: corriente de carga senoidal con pico de 34 A (≈ 910 W a 26,8 V)
    const vBat = 26.8, iCarga = h > 6 && h < 18 ? 34 * Math.sin((Math.PI * (h - 6)) / 12) : 0;
    solar.push({ t, w: potenciaSolar(vBat, iCarga) });
    // consumo base 5 % del inversor, 12 % por la noche (luces, TV de 18:30 a 22:30)
    const cargaPct = h >= 18.5 && h < 22.5 ? 12 : 5;
    consumo.push({ t, w: consumoCasa(cargaPct) });
  }

  L('=== Potencias instantáneas ===');
  L('Solar con 26,8 V y 34 A de carga: ' + potenciaSolar(26.8, 34).toFixed(0) + ' W');
  L('Consumo con el inversor al 12 %:  ' + consumoCasa(12).toFixed(0) + ' W');

  L('\n=== Energía por día (trapecio, día local UTC-5) ===');
  L('Generada:  ' + JSON.stringify(mapear(energiaPorDiaKWh(solar), r2)));
  L('Consumida: ' + JSON.stringify(mapear(energiaPorDiaKWh(consumo), r2)));

  L('\n=== Resumen del día (extra) ===');
  const res = resumenDiario(solar, consumo, 1200 /* W FV instalados: ejemplo, ajustar */);
  for (const [k, v] of Object.entries(res)) L('  ' + k.padEnd(18) + (v === null ? '—' : r2(v)));

  L('\n=== Batería ===');
  L('Capacidad útil (100 % → ' + SISTEMA.socMinimo + ' %): ' + capacidadUtilWh() + ' Wh');
  L('Capacidad equivalente del banco: ' + r1(capacidadEquivalenteAh()) + ' Ah a ' + SISTEMA.voltajeSistemaV + ' V');
  const a2030 = medianoche + 20.5 * 3600e3; // 20:30, sin sol y con la TV encendida
  const consumoProm = promedioReciente(consumo, 30, a2030);
  const solarProm = promedioReciente(solar, 30, a2030);
  for (const soc of [80, 45, 22, 15]) {
    const a = autonomia({ soc, consumoPromW: consumoProm, solarPromW: solarProm, modoInversor: 'Inverter mode' });
    L('  SOC ' + String(soc).padStart(3) + ' % a las 20:30 → ' + a.texto + ', disponibles ' + a.disponibleWh + ' Wh');
  }
  const mediodia = medianoche + 12 * 3600e3;
  const aMd = autonomia({ soc: 60, consumoPromW: promedioReciente(consumo, 30, mediodia), solarPromW: promedioReciente(solar, 30, mediodia), modoInversor: 'Inverter mode' });
  L('  SOC  60 % al mediodía     → ' + aMd.texto);
  const tl = tiempoHastaLlenaH({ soc: 60, consumoPromW: promedioReciente(consumo, 30, mediodia), solarPromW: promedioReciente(solar, 30, mediodia) });
  L('  Tiempo hasta el 100 % al mediodía (extra): ' + formatoHoras(tl));
  L('  Con red eléctrica → ' + autonomia({ soc: 50, consumoPromW: 0, modoInversor: 'Mains mode' }).texto);

  L('\n=== Calibración de Wh por 1 % (madrugada, sin sol ni red) ===');
  const madrugada = consumo.filter((p) => p.t <= medianoche + 5.5 * 3600e3);
  L('  Consumo 00:00–05:30: ' + r1(energiaWh(madrugada)) + ' Wh; si el SOC bajó del 50 % al 32 %: '
    + r1(calibrarWhPorPct({ consumo: madrugada, socInicio: 50, socFin: 32 })) + ' Wh por %');

  L('\n=== Ahorro automático (umbrales 30/20 %, histéresis 5) ===');
  let estado = 'Normal';
  const recorrido = [50, 31, 30, 25, 20, 18, 22, 25, 27, 34, 35, 40];
  L('  ' + recorrido.map((soc) => (estado = estadoAhorro(estado, soc), soc + '%→' + estado)).join('  '));

  L('\n=== Lecturas congeladas ===');
  const ahora = Date.now();
  for (const min of [4, 16]) {
    const v = lecturaVieja(ahora - min * 60e3, ahora);
    L('  Lectura de hace ' + v.edadMin + ' min: ' + (v.vieja ? 'vieja, no publicar' : 'válida'));
  }

  function r2(x) { return Math.round(x * 100) / 100; }
  function mapear(o, f) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])); }
}
