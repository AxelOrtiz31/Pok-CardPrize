importScripts("./pokemon-core.js");

const CACHE_NAME = "precio-cartas-pokemon-v1";
const WIDGET_TAG = "pokemon-precio-widget";

const APP_FILES = [
  "./",
  "./index.html",
  "./pokemon.css",
  "./pokemon.js",
  "./pokemon-core.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./widgets/pokemon-template.json",
  "./widgets/pokemon-data.json",
  "./widgets/screenshot-widget.png"
];

/* =========================================
   CICLO DE VIDA Y CACHÉ
========================================= */

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_FILES.map(file => cache.add(file)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key => key.startsWith("precio-cartas-pokemon-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
    await renderWidgetByTag(WIDGET_TAG);
  })());
});

// Solo se gestionan los archivos de la propia app (red primero, caché de respaldo).
// Las consultas de precios y de tipo de cambio NUNCA se guardan en caché.
self.addEventListener("fetch", event => {
  const peticion = event.request;
  if (peticion.method !== "GET") return;

  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const respuesta = await fetch(peticion);
      if (respuesta.ok) await cache.put(peticion, respuesta.clone());
      return respuesta;
    } catch {
      const guardado = await cache.match(peticion, { ignoreSearch: true });
      if (guardado) return guardado;

      if (peticion.mode === "navigate") {
        const inicio = await cache.match("./index.html");
        if (inicio) return inicio;
      }

      return new Response("Recurso no disponible sin conexión", {
        status: 503,
        statusText: "Service Unavailable"
      });
    }
  })());
});

/* =========================================
   WIDGET
========================================= */

async function estadoDesdeBusqueda(entradas) {
  const nombre = String(entradas.nombre ?? "").trim();
  const numero = String(entradas.numero ?? "").trim();
  const moneda = entradas.moneda === "USD" ? "USD" : "MXN";

  const base = { nombre, numero, moneda, precio: "", linea2: "", linea3: "", color: "Default" };

  if (!nombre && !numero) {
    return {
      ...base,
      titulo: "Faltan datos",
      linea1: "Escribe el nombre (en inglés) o el número impreso, por ejemplo 25/165.",
      color: "Attention"
    };
  }

  try {
    const [resultado, cambio] = await Promise.all([
      PokeCore.buscarCartas({ nombre, numero }),
      PokeCore.obtenerTipoCambio().catch(() => null)
    ]);

    if (!resultado.cartas.length) {
      return {
        ...base,
        titulo: "Sin resultados",
        linea1: "No se encontró la carta. Revisa el nombre en inglés y el número.",
        color: "Attention"
      };
    }

    const carta = resultado.cartas[0];
    const principal = carta.principal;
    const masCoincidencias = resultado.cartas.length - 1;

    let precio = "Sin precio disponible";
    let detalle = "";

    if (principal) {
      const usd = PokeCore.dinero(principal.precio, "USD");

      if (moneda === "MXN" && cambio) {
        precio = PokeCore.dinero(principal.precio * cambio.tasa, "MXN");
        detalle = `${usd} · ${principal.etiqueta} · TCGplayer`;
      } else {
        precio = usd;
        detalle = `${principal.etiqueta} · TCGplayer` +
          (moneda === "MXN" ? " · sin tipo de cambio disponible" : "");
      }
    }

    return {
      ...base,
      titulo: `${carta.nombre} · ${carta.numero}/${carta.totalSet ?? "?"}`,
      linea1: `${carta.set}${carta.rareza ? " · " + carta.rareza : ""}`,
      precio,
      linea2: detalle,
      linea3: masCoincidencias > 0
        ? `+${masCoincidencias} coincidencias más: ábrelas en la app.`
        : "Precio de referencia; puede diferir del mercado local.",
      color: principal ? "Good" : "Attention"
    };
  } catch {
    return {
      ...base,
      titulo: "Sin conexión con el servicio",
      linea1: "No se pudo consultar el precio. Inténtalo de nuevo en un momento.",
      color: "Attention"
    };
  }
}

async function fetchTemplate(widget) {
  const respuesta = await fetch(widget.definition.msAcTemplate);
  if (!respuesta.ok) throw new Error("No se pudo cargar la plantilla.");
  return respuesta.text();
}

async function renderWidget(widget, estado = null) {
  const template = await fetchTemplate(widget);

  let data;
  if (estado) {
    data = JSON.stringify(estado);
  } else {
    const respuesta = await fetch(widget.definition.data);
    if (!respuesta.ok) throw new Error("No se pudieron cargar los datos.");
    data = await respuesta.text();
  }

  await self.widgets.updateByTag(widget.definition.tag, { template, data });
}

async function renderWidgetByTag(tag) {
  if (!("widgets" in self)) return;

  const widget = await self.widgets.getByTag(tag);
  if (widget) await renderWidget(widget);
}

function lastState(widget) {
  try {
    const payload = widget?.instances?.[0]?.payload;
    return payload?.data ? JSON.parse(payload.data) : null;
  } catch {
    return null;
  }
}

async function readInputs(event) {
  let data = event.data;

  try {
    if (data && typeof data.json === "function") data = await data.json();
    else if (typeof data === "string") data = JSON.parse(data);
  } catch {
    data = null;
  }

  return data && typeof data === "object" ? data : {};
}

self.addEventListener("widgetinstall", event => {
  event.waitUntil(renderWidget(event.widget));
});

self.addEventListener("widgetresume", event => {
  event.waitUntil(renderWidget(event.widget, lastState(event.widget)));
});

self.addEventListener("widgetclick", event => {
  event.waitUntil((async () => {
    const tag = event.widget?.definition?.tag ?? WIDGET_TAG;
    const widget = await self.widgets.getByTag(tag);
    if (!widget) return;

    const entradas = { ...(lastState(widget) ?? {}), ...(await readInputs(event)) };

    if (event.action === "abrir-app") {
      const params = new URLSearchParams();
      if (entradas.nombre) params.set("nombre", String(entradas.nombre).trim());
      if (entradas.numero) params.set("numero", String(entradas.numero).trim());

      const consulta = params.toString();
      await self.clients.openWindow(consulta ? `./?${consulta}` : "./");
      return;
    }

    if (event.action === "buscar") {
      await renderWidget(widget, await estadoDesdeBusqueda(entradas));
    }
  })());
});
