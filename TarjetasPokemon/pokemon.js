"use strict";

const entradaFoto = document.getElementById("foto");
const botonFoto = document.getElementById("btn-foto");
const vistaPrevia = document.getElementById("vista-previa");
const estado = document.getElementById("estado");
const formulario = document.getElementById("busqueda");
const campoNombre = document.getElementById("nombre");
const campoNumero = document.getElementById("numero");
const campoMoneda = document.getElementById("moneda");
const botonBuscar = document.getElementById("btn-buscar");
const zonaResultados = document.getElementById("resultados");
const zonaDetalle = document.getElementById("detalle");

const TESSERACT_URL =
    "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

let cartasEncontradas = [];
let cartaSeleccionada = null;
let tipoCambio = null;
let ocupado = false;
let urlVistaPrevia = null;

/* =========================================
   UTILIDADES
========================================= */

function el(etiqueta, props = {}, ...hijos) {
    const nodo = document.createElement(etiqueta);

    for (const [clave, valor] of Object.entries(props)) {
        if (clave === "class") nodo.className = valor;
        else if (clave === "text") nodo.textContent = valor;
        else if (clave.startsWith("on")) nodo.addEventListener(clave.slice(2), valor);
        else nodo.setAttribute(clave, valor);
    }

    for (const hijo of hijos.flat()) {
        if (hijo !== null && hijo !== undefined) nodo.append(hijo);
    }

    return nodo;
}

function setEstado(texto, tipo = "") {
    estado.textContent = texto;
    estado.className = "estado" + (tipo ? " " + tipo : "");
}

// Precio en la moneda elegida (si no hay tipo de cambio, cae a dólares).
function precioEnMoneda(usd) {
    if (campoMoneda.value === "MXN" && tipoCambio) {
        const valor = usd * tipoCambio.tasa;
        return { valor, moneda: "MXN", texto: PokeCore.dinero(valor, "MXN") };
    }

    return { valor: usd, moneda: "USD", texto: PokeCore.dinero(usd, "USD") };
}

function notaTipoCambio() {
    if (!tipoCambio) {
        return "No se pudo obtener el tipo de cambio; los precios se muestran en dólares.";
    }

    const fecha = tipoCambio.fecha ? ` (${tipoCambio.fecha})` : "";
    const aviso = tipoCambio.enCache ? " Último valor guardado, sin conexión al servicio." : "";

    return `Tipo de cambio: 1 USD = ${tipoCambio.tasa.toFixed(4)} MXN${fecha}.${aviso}`;
}

/* =========================================
   LECTURA DE LA FOTO (OCR)
========================================= */

let promesaTesseract = null;
let trabajador = null;

function cargarTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);

    if (!promesaTesseract) {
        promesaTesseract = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = TESSERACT_URL;
            script.async = true;
            script.onload = () => resolve(window.Tesseract);
            script.onerror = () => {
                promesaTesseract = null;
                reject(new Error(
                    "No se pudo cargar el lector de texto. Se necesita conexión a internet."
                ));
            };
            document.head.appendChild(script);
        });
    }

    return promesaTesseract;
}

async function obtenerTrabajador() {
    const T = await cargarTesseract();

    if (!trabajador) {
        setEstado("Preparando el lector de texto (la primera vez tarda un poco)…");

        trabajador = await T.createWorker("eng", 1, {
            logger: m => {
                if (m.status === "recognizing text") {
                    setEstado(`Leyendo la carta… ${Math.round(m.progress * 100)}%`);
                }
            }
        });
    }

    return { T, trabajador };
}

async function cargarImagen(archivo) {
    if ("createImageBitmap" in window) {
        try {
            return await createImageBitmap(archivo, { imageOrientation: "from-image" });
        } catch { /* se intenta con <img> */ }
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(
            "No se pudo abrir la imagen. Prueba con una foto JPG o PNG."
        ));
        img.src = URL.createObjectURL(archivo);
    });
}

// Recorta una franja de la imagen y la deja en gris con más contraste.
function dibujarRegion(imagen, desde, hasta) {
    const ancho = imagen.naturalWidth || imagen.width;
    const alto = imagen.naturalHeight || imagen.height;

    const origenY = Math.floor(alto * desde);
    const altoOrigen = Math.max(1, Math.floor(alto * (hasta - desde)));
    const escala = Math.min(2, 1400 / ancho);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(ancho * escala));
    canvas.height = Math.max(1, Math.round(altoOrigen * escala));

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(imagen, 0, origenY, ancho, altoOrigen, 0, 0, canvas.width, canvas.height);

    const pixeles = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const datos = pixeles.data;

    for (let i = 0; i < datos.length; i += 4) {
        const gris = 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
        const v = Math.max(0, Math.min(255, (gris - 128) * 1.5 + 128));
        datos[i] = datos[i + 1] = datos[i + 2] = v;
    }

    ctx.putImageData(pixeles, 0, 0);
    return canvas;
}

async function leerRegion(trabajadorOCR, T, canvas, modo, lista) {
    await trabajadorOCR.setParameters({
        tessedit_pageseg_mode: modo,
        tessedit_char_whitelist: lista
    });

    const { data } = await trabajadorOCR.recognize(canvas);
    return data.text || "";
}

async function procesarFoto(archivo) {
    if (!archivo || ocupado) return;

    if (!archivo.type.startsWith("image/")) {
        setEstado("El archivo debe ser una imagen.", "error");
        return;
    }

    if (urlVistaPrevia) URL.revokeObjectURL(urlVistaPrevia);
    urlVistaPrevia = URL.createObjectURL(archivo);
    vistaPrevia.src = urlVistaPrevia;
    vistaPrevia.hidden = false;

    zonaResultados.replaceChildren();
    zonaDetalle.replaceChildren();
    cartaSeleccionada = null;

    ocupado = true;
    botonFoto.disabled = true;
    botonBuscar.disabled = true;

    let nombre = "";
    let numero = "";
    let fallo = null;

    try {
        setEstado("Preparando la imagen…");
        const imagen = await cargarImagen(archivo);
        const { T, trabajador: ocr } = await obtenerTrabajador();

        // Nombre: franja superior. Número: franja inferior.
        const textoNombre = await leerRegion(
            ocr, T, dibujarRegion(imagen, 0, 0.2), T.PSM.SINGLE_BLOCK, ""
        );

        const textoNumero = await leerRegion(
            ocr, T, dibujarRegion(imagen, 0.8, 1), T.PSM.SPARSE_TEXT, "0123456789/"
        );

        nombre = PokeCore.extraerNombreDeOCR(textoNombre);
        numero = PokeCore.extraerNumeroDeOCR(textoNumero);
    } catch (error) {
        console.error(error);
        fallo = error;
    } finally {
        ocupado = false;
        botonFoto.disabled = false;
        botonBuscar.disabled = false;
    }

    if (fallo) {
        setEstado(fallo.message || "No se pudo leer la foto.", "error");
        return;
    }

    campoNombre.value = nombre;
    campoNumero.value = numero;

    if (nombre || numero) {
        await buscar();
    } else {
        setEstado(
            "No pude leer la carta. Intenta con una foto más nítida y de frente, " +
            "o escribe el nombre y el número a mano.",
            "error"
        );
    }
}

/* =========================================
   BÚSQUEDA Y RESULTADOS
========================================= */

async function buscar() {
    if (ocupado) return;

    const nombre = campoNombre.value.trim();
    const numero = campoNumero.value.trim();

    if (!nombre && !numero) {
        setEstado("Escribe el nombre o el número de la carta, o sube una foto.", "error");
        return;
    }

    ocupado = true;
    botonBuscar.disabled = true;
    botonFoto.disabled = true;
    setEstado("Buscando precios…");

    zonaResultados.replaceChildren();
    zonaDetalle.replaceChildren();
    cartaSeleccionada = null;

    try {
        const [resultado, cambio] = await Promise.all([
            PokeCore.buscarCartas({ nombre, numero }),
            PokeCore.obtenerTipoCambio().catch(() => null)
        ]);

        tipoCambio = cambio;
        cartasEncontradas = resultado.cartas;

        if (!cartasEncontradas.length) {
            setEstado(
                "No se encontró ninguna carta. Revisa el nombre (en inglés) y el número impreso.",
                "error"
            );
            return;
        }

        if (cartasEncontradas.length === 1) {
            setEstado(`Carta encontrada por ${resultado.criterio}.`, "ok");
            seleccionarCarta(cartasEncontradas[0]);
        } else {
            setEstado(
                `Encontré ${cartasEncontradas.length} coincidencias por ${resultado.criterio}. ` +
                "Elige la que se parece a la tuya.",
                "ok"
            );
            renderResultados();
        }
    } catch (error) {
        console.error(error);
        setEstado(
            "El servicio de precios no respondió. Revisa tu conexión e inténtalo otra vez.",
            "error"
        );
    } finally {
        ocupado = false;
        botonBuscar.disabled = false;
        botonFoto.disabled = false;
    }
}

function renderResultados() {
    zonaResultados.replaceChildren(
        ...cartasEncontradas.map(carta => {
            const principal = carta.principal;
            const textoPrecio = principal
                ? precioEnMoneda(principal.precio).texto
                : "Sin precio disponible";

            return el("article", { class: "carta" },
                el("img", { src: carta.imagen, alt: `Carta ${carta.nombre}`, loading: "lazy" }),
                el("div", {},
                    el("h4", { text: carta.nombre }),
                    el("div", {
                        class: "meta",
                        text: `${carta.set} · ${carta.numero}/${carta.totalSet ?? "?"}` +
                              (carta.rareza ? ` · ${carta.rareza}` : "")
                    }),
                    el("div", { class: "precio", text: textoPrecio }),
                    el("button", {
                        type: "button",
                        text: "Ver detalle",
                        onclick: () => seleccionarCarta(carta)
                    })
                )
            );
        })
    );
}

function seleccionarCarta(carta) {
    cartaSeleccionada = carta;
    renderDetalle();
    zonaDetalle.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

function renderDetalle() {
    const carta = cartaSeleccionada;
    if (!carta) return;

    const principal = carta.principal;
    const precio = principal ? precioEnMoneda(principal.precio) : null;

    const lineasVariantes = carta.variantes.map(v => {
        const p = precioEnMoneda(v.precio);
        return el("li", {},
            el("span", { text: v.etiqueta }),
            el("strong", { text: p.texto })
        );
    });

    const actualizado = carta.actualizado
        ? `Precios actualizados: ${carta.actualizado}. `
        : "";

    const enlace = carta.tcgUrl
        ? el("a", { href: carta.tcgUrl, target: "_blank", rel: "noopener noreferrer", text: "Ver en TCGplayer" })
        : null;

    const tarjeta = el("div", { class: "detalle-card" },
        el("div", { class: "cabecera" },
            el("img", { src: carta.imagenGrande, alt: `Carta ${carta.nombre}` }),
            el("div", {},
                el("h3", { text: carta.nombre }),
                el("div", { class: "meta", text: `${carta.set} (${carta.serie})` }),
                el("div", {
                    class: "meta",
                    text: `Número ${carta.numero}/${carta.totalSet ?? "?"}` +
                          (carta.rareza ? ` · ${carta.rareza}` : "")
                }),
                el("div", { class: "etiqueta-precio", text: "PRECIO DE MERCADO" }),
                el("div", {
                    class: "precio-grande",
                    text: precio ? precio.texto : "Sin precio disponible"
                })
            )
        ),
        lineasVariantes.length > 1
            ? el("ul", { class: "variantes" }, lineasVariantes)
            : null,
        el("p", {
            class: "nota"
        },
            `${actualizado}${notaTipoCambio()} Valor de referencia de TCGplayer ` +
            "(precio de mercado, carta cercana a nueva); puede diferir del precio local. ",
            enlace
        ),
        el("div", { class: "reporte-acciones" },
            el("button", {
                type: "button", class: "btn-reporte",
                text: "Descargar reporte para Word",
                onclick: descargarReporte
            }),
            el("button", {
                type: "button", class: "btn-compartir",
                text: "Compartir reporte",
                onclick: compartirReporte
            })
        )
    );

    zonaDetalle.replaceChildren(tarjeta);
}

campoMoneda.addEventListener("change", () => {
    if (cartasEncontradas.length > 1) renderResultados();
    if (cartaSeleccionada) renderDetalle();
});

formulario.addEventListener("submit", evento => {
    evento.preventDefault();
    buscar();
});

botonFoto.addEventListener("click", () => entradaFoto.click());

entradaFoto.addEventListener("change", () => {
    const archivo = entradaFoto.files?.[0];
    entradaFoto.value = "";
    procesarFoto(archivo);
});

/* =========================================
   REPORTE PARA WORD (RTF) Y COMPARTIR
========================================= */

function escaparRTF(texto) {
    let resultado = "";

    for (const caracter of String(texto)) {
        const codigo = caracter.codePointAt(0);

        if (caracter === "\\") {
            resultado += "\\\\";
        } else if (caracter === "{") {
            resultado += "\\{";
        } else if (caracter === "}") {
            resultado += "\\}";
        } else if (codigo > 127) {
            const unidades = [];

            if (codigo <= 0xFFFF) {
                unidades.push(codigo);
            } else {
                const punto = codigo - 0x10000;
                unidades.push(0xD800 + (punto >> 10));
                unidades.push(0xDC00 + (punto & 0x3FF));
            }

            for (const unidad of unidades) {
                const firmado = unidad > 32767 ? unidad - 65536 : unidad;
                resultado += `\\u${firmado}?`;
            }
        } else {
            resultado += caracter;
        }
    }

    return resultado;
}

function crearReporteRTF(carta) {
    const fecha = new Date().toLocaleString("es-MX");
    const moneda = campoMoneda.value === "MXN" && tipoCambio ? "MXN" : "USD";

    const lineas = [
        { texto: "PRECIO DE CARTAS POKÉMON", tipo: "titulo" },
        { texto: "REPORTE DE PRECIO DE MERCADO", tipo: "subtitulo" },
        { texto: "" },
        { texto: `Fecha y hora: ${fecha}` },
        { texto: "" },
        { texto: "1. DATOS DE LA CARTA", tipo: "seccion" },
        { texto: `Nombre: ${carta.nombre}` },
        { texto: `Colección: ${carta.set} (${carta.serie})` },
        { texto: `Número: ${carta.numero}/${carta.totalSet ?? "?"}` },
        { texto: `Rareza: ${carta.rareza || "No disponible"}` },
        { texto: "" },
        { texto: "2. PRECIOS DE MERCADO", tipo: "seccion" }
    ];

    if (carta.variantes.length) {
        for (const v of carta.variantes) {
            const usd = PokeCore.dinero(v.precio, "USD");
            const mxn = tipoCambio
                ? PokeCore.dinero(v.precio * tipoCambio.tasa, "MXN")
                : "no disponible";

            const marca = v === carta.principal ? " (principal)" : "";
            lineas.push({ texto: `${v.etiqueta}${marca}: ${usd} | ${mxn}` });
        }
    } else {
        lineas.push({ texto: "No hay precio disponible para esta carta." });
    }

    lineas.push(
        { texto: "" },
        { texto: `Moneda mostrada en pantalla: ${moneda}` },
        { texto: "" },
        { texto: "3. TIPO DE CAMBIO", tipo: "seccion" },
        {
            texto: tipoCambio
                ? `1 USD = ${tipoCambio.tasa.toFixed(4)} MXN` +
                  (tipoCambio.fecha ? ` (${tipoCambio.fecha})` : "")
                : "No disponible al momento de generar el reporte."
        },
        { texto: "" },
        { texto: "4. OBSERVACIONES", tipo: "seccion" },
        { texto: "Fuente de precios: TCGplayer, obtenidos mediante pokemontcg.io." },
        { texto: "Es un precio de mercado de referencia para una carta cercana a nueva." },
        { texto: "El valor real depende del estado, la edición y el vendedor." }
    );

    const contenido = lineas.map(linea => {
        const texto = escaparRTF(linea.texto);

        if (linea.tipo === "titulo") return `\\pard\\qc\\b\\fs36 ${texto}\\b0\\fs22\\par`;
        if (linea.tipo === "subtitulo") return `\\pard\\qc\\b\\fs26 ${texto}\\b0\\fs22\\par`;
        if (linea.tipo === "seccion") return `\\pard\\sb240\\sa120\\b\\fs24 ${texto}\\b0\\fs22\\par`;

        return `\\pard\\sa100\\fs22 ${texto}\\par`;
    }).join("\n");

    return (
        "{\\rtf1\\ansi\\deff0\\uc1" +
        "{\\fonttbl{\\f0\\fswiss Arial;}}" +
        "\\viewkind4\\f0\\fs22 " +
        contenido +
        "}"
    );
}

function crearArchivoRTF(carta) {
    return new Blob([crearReporteRTF(carta)], { type: "application/rtf;charset=utf-8" });
}

function descargarReporte() {
    if (!cartaSeleccionada) {
        alert("Primero busca una carta.");
        return;
    }

    const url = URL.createObjectURL(crearArchivoRTF(cartaSeleccionada));
    const enlace = document.createElement("a");

    enlace.href = url;
    enlace.download = "Reporte_Precio_Carta_Pokemon.rtf";
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function compartirReporte() {
    if (!cartaSeleccionada) {
        alert("Primero busca una carta.");
        return;
    }

    const archivo = new File(
        [crearArchivoRTF(cartaSeleccionada)],
        "Reporte_Precio_Carta_Pokemon.rtf",
        { type: "application/rtf" }
    );

    try {
        if (
            typeof navigator.share === "function" &&
            typeof navigator.canShare === "function" &&
            navigator.canShare({ files: [archivo] })
        ) {
            await navigator.share({
                title: "Reporte de precio de carta Pokémon",
                text: "Reporte generado por Precio de Cartas Pokémon.",
                files: [archivo]
            });
        } else {
            descargarReporte();
            alert(
                "Tu navegador no permite compartir este archivo directamente. " +
                "Se descargó el reporte para que puedas adjuntarlo manualmente."
            );
        }
    } catch (error) {
        if (error.name !== "AbortError") {
            alert("No se pudo compartir el archivo. Intenta descargarlo.");
            console.error(error);
        }
    }
}

/* =========================================
   ARRANQUE: SERVICE WORKER, ENLACES DEL WIDGET
========================================= */

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js", { scope: "./" })
            .catch(error => console.error("Error al registrar el Service Worker:", error));
    });
}

// El widget abre la app con ?nombre=...&numero=...
(function buscarDesdeEnlace() {
    const params = new URLSearchParams(location.search);
    const nombre = params.get("nombre");
    const numero = params.get("numero");

    if (nombre || numero) {
        campoNombre.value = nombre ?? "";
        campoNumero.value = numero ?? "";
        buscar();
    }
})();

/* =========================================
   FLECHA PARA OCULTAR Y MOSTRAR EL ENCABEZADO
========================================= */

const flechaEncabezado = document.querySelector(".drag");
const encabezado = document.querySelector("body > header");

if (flechaEncabezado && encabezado) {
    flechaEncabezado.setAttribute("aria-expanded", "true");

    function alternarEncabezado() {
        const oculto = document.body.classList.toggle("header-collapsed");

        flechaEncabezado.setAttribute("aria-expanded", String(!oculto));
        flechaEncabezado.setAttribute(
            "aria-label",
            oculto ? "Mostrar encabezado" : "Ocultar encabezado"
        );

        const flecha = flechaEncabezado.querySelector(".drag-arrow");
        if (flecha) flecha.textContent = oculto ? "⌄" : "⌃";
    }

    flechaEncabezado.addEventListener("click", alternarEncabezado);
}
