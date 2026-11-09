/* =========================================
   NÚCLEO COMPARTIDO (página + service worker)
   Búsqueda de cartas, precios y tipo de cambio.
========================================= */
(function (g) {
  "use strict";

  const API_URL = "https://api.pokemontcg.io/v2/cards";

  // Opcional: clave gratuita de https://dev.pokemontcg.io para más límite de consultas.
  const API_KEY = "";

  const CAMPOS = "id,name,number,rarity,set,images,tcgplayer,cardmarket";

  const ETIQUETAS = {
    normal: "Normal",
    holofoil: "Holo",
    reverseHolofoil: "Reverse Holo",
    "1stEditionNormal": "1ª edición Normal",
    "1stEditionHolofoil": "1ª edición Holo",
    unlimitedNormal: "Ilimitada Normal",
    unlimitedHolofoil: "Ilimitada Holo"
  };

  // Variante que se muestra como "precio principal".
  const ORDEN_PRINCIPAL = [
    "holofoil", "normal", "reverseHolofoil",
    "unlimitedHolofoil", "unlimitedNormal",
    "1stEditionHolofoil", "1stEditionNormal"
  ];

  // Palabras impresas en la carta que NO son parte del nombre.
  const IGNORADAS = new Set([
    "basic", "basico", "stage", "fase", "hp", "ps", "trainer", "entrenador",
    "item", "objeto", "supporter", "partidario", "stadium", "estadio",
    "tool", "herramienta", "energy", "energia", "pokemon", "pokémon"
  ]);

  const sinAcentos = t =>
    String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  /* ---------- Red ---------- */

  async function pedirJSON(url, { headers = {}, timeout = 25000, reintentos = 1 } = {}) {
    let ultimoError;

    for (let i = 0; i <= reintentos; i++) {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), timeout);

      try {
        const respuesta = await fetch(url, { headers, signal: control.signal });
        if (!respuesta.ok) throw new Error("HTTP " + respuesta.status);
        return await respuesta.json();
      } catch (error) {
        ultimoError = error;
      } finally {
        clearTimeout(reloj);
      }
    }

    throw ultimoError;
  }

  /* ---------- Texto leído de la carta (OCR) ---------- */

  function limpiarNombre(texto) {
    return String(texto ?? "")
      .replace(/["\\*:()]/g, " ")
      .replace(/[^\p{L}\p{N} '\-.]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extraerNombreDeOCR(texto) {
    const lineas = String(texto ?? "").split(/\n+/);

    for (const linea of lineas) {
      const minuscula = sinAcentos(linea).toLowerCase();
      if (/evolves|evoluciona/.test(minuscula)) continue;

      const palabras = linea
        .replace(/\d+/g, " ")
        .split(/\s+/)
        .map(p => p.replace(/[^\p{L}'\-]/gu, ""))
        .filter(p => p.length >= 2)
        .filter(p => !IGNORADAS.has(sinAcentos(p).toLowerCase()));

      const nombre = palabras.join(" ");
      if ((nombre.match(/\p{L}/gu) || []).length >= 3) return nombre;
    }

    return "";
  }

  function extraerNumeroDeOCR(texto) {
    const patron = /(\d{1,3})\s*\/\s*(\d{1,3})/g;
    let m;

    while ((m = patron.exec(String(texto ?? ""))) !== null) {
      const numero = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (numero >= 1 && total >= 10) return `${numero}/${total}`;
    }

    return "";
  }

  /* ---------- Consulta a la API ---------- */

  function sinCeros(valor) {
    return String(valor).replace(/^0+(?=\d)/, "");
  }

  // Acepta "25/165", "025/165", "25", "TG05/TG30", "SWSH001".
  function interpretarNumero(texto) {
    const t = String(texto ?? "").trim().replace(/\s+/g, "");
    const m = t.match(/^([A-Za-z]{0,4}\d{1,3})(?:\/([A-Za-z]{0,4}\d{1,3}))?$/);
    if (!m) return null;

    const numero = /^\d+$/.test(m[1]) ? sinCeros(m[1]) : m[1].toUpperCase();
    const total = m[2] && /^\d+$/.test(m[2]) ? sinCeros(m[2]) : null;

    return { numero, total };
  }

  function consultaNombre(nombre) {
    const n = limpiarNombre(nombre);
    if (!n) return "";
    return n.includes(" ") ? `name:"${n}"` : `name:${n}*`;
  }

  function consultaNumero(info) {
    if (!info) return "";
    let q = `number:"${info.numero}"`;
    if (info.total) q += ` set.printedTotal:${info.total}`;
    return q;
  }

  // Intentos de búsqueda, del más preciso al más amplio.
  function construirIntentos({ nombre, numero }) {
    const info = interpretarNumero(numero);
    const qNombre = consultaNombre(nombre);
    const qNumero = consultaNumero(info);
    const intentos = [];

    if (qNombre && qNumero) {
      intentos.push({ q: `${qNombre} ${qNumero}`, criterio: "nombre y número" });
    }
    if (qNumero && info.total) {
      intentos.push({ q: qNumero, criterio: "número y total de la colección" });
    }
    if (qNombre) {
      intentos.push({ q: qNombre, criterio: "nombre" });
    }
    if (qNumero && !info.total && !qNombre) {
      intentos.push({ q: qNumero, criterio: "número" });
    }

    return intentos;
  }

  function normalizarCarta(c) {
    const precios = c.tcgplayer?.prices ?? {};

    const variantes = Object.entries(precios)
      .map(([clave, p]) => ({
        clave,
        etiqueta: ETIQUETAS[clave] ?? clave,
        market: p?.market ?? null,
        low: p?.low ?? null,
        mid: p?.mid ?? null,
        high: p?.high ?? null,
        precio: p?.market ?? p?.mid ?? p?.low ?? null
      }))
      .filter(v => Number.isFinite(v.precio));

    let principal = null;
    for (const clave of ORDEN_PRINCIPAL) {
      principal = variantes.find(v => v.clave === clave);
      if (principal) break;
    }
    principal = principal ?? variantes[0] ?? null;

    const cm = c.cardmarket?.prices ?? {};

    return {
      id: c.id,
      nombre: c.name,
      numero: c.number,
      totalSet: c.set?.printedTotal ?? null,
      set: c.set?.name ?? "",
      serie: c.set?.series ?? "",
      rareza: c.rarity ?? "",
      imagen: c.images?.small ?? "",
      imagenGrande: c.images?.large ?? c.images?.small ?? "",
      tcgUrl: c.tcgplayer?.url ?? "",
      actualizado: c.tcgplayer?.updatedAt ?? "",
      variantes,
      principal,
      cardmarketEUR: cm.trendPrice ?? cm.averageSellPrice ?? null
    };
  }

  async function buscarCartas({ nombre = "", numero = "" } = {}) {
    const intentos = construirIntentos({ nombre, numero });
    if (!intentos.length) return { cartas: [], criterio: "" };

    const headers = API_KEY ? { "X-Api-Key": API_KEY } : {};

    for (const intento of intentos) {
      const url =
        `${API_URL}?q=${encodeURIComponent(intento.q)}` +
        `&pageSize=12&orderBy=-set.releaseDate&select=${CAMPOS}`;

      const json = await pedirJSON(url, { headers });
      const cartas = (json?.data ?? []).map(normalizarCarta);

      if (cartas.length) return { cartas, criterio: intento.criterio };
    }

    return { cartas: [], criterio: "" };
  }

  /* ---------- Tipo de cambio USD → MXN ---------- */

  const CLAVE_CAMBIO = "pokemon-tipo-cambio-usd-mxn";

  function leerCambioGuardado() {
    try {
      return JSON.parse(g.localStorage?.getItem(CLAVE_CAMBIO) ?? "null");
    } catch {
      return null;
    }
  }

  function guardarCambio(valor) {
    try {
      g.localStorage?.setItem(CLAVE_CAMBIO, JSON.stringify(valor));
    } catch { /* sin almacenamiento disponible */ }
  }

  async function obtenerTipoCambio() {
    const fuentes = [
      {
        url: "https://api.frankfurter.app/latest?base=USD&symbols=MXN",
        leer: j => ({ tasa: Number(j?.rates?.MXN), fecha: j?.date })
      },
      {
        url: "https://api.frankfurter.dev/v2/rate/usd/mxn",
        leer: j => ({ tasa: Number(j?.rate ?? j?.rates?.MXN), fecha: j?.date })
      }
    ];

    for (const fuente of fuentes) {
      try {
        const json = await pedirJSON(fuente.url, { timeout: 8000, reintentos: 0 });
        const { tasa, fecha } = fuente.leer(json);

        if (Number.isFinite(tasa) && tasa > 0) {
          const resultado = {
            tasa,
            fecha: fecha ?? null,
            fuente: "Frankfurter (Banco Central Europeo)",
            enCache: false
          };
          guardarCambio(resultado);
          return resultado;
        }
      } catch { /* probar siguiente fuente */ }
    }

    const guardado = leerCambioGuardado();
    if (guardado?.tasa > 0) return { ...guardado, enCache: true };

    throw new Error("No se pudo obtener el tipo de cambio.");
  }

  /* ---------- Formato ---------- */

  function dinero(valor, moneda) {
    return "$" + Number(valor).toLocaleString("es-MX", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + " " + moneda;
  }

  g.PokeCore = {
    buscarCartas,
    obtenerTipoCambio,
    interpretarNumero,
    construirIntentos,
    extraerNombreDeOCR,
    extraerNumeroDeOCR,
    limpiarNombre,
    dinero
  };
})(typeof self !== "undefined" ? self : globalThis);
