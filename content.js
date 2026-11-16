(() => {
if (globalThis.__sriProLoaded) return;
globalThis.__sriProLoaded = true;
let portalBusy = false;
let syncLeaseUntil = 0;

async function withPortalLock(operation) {
  if (portalBusy) throw new Error("Hay otra operación en el portal. Espera a que termine.");
  portalBusy = true;
  try { return await operation(); } finally { portalBusy = false; }
}
// content.js - Logica de extraccion e interaccion con la pagina (v3.2)

/**
 * Detecta si el contexto actual del portal SRI corresponde a comprobantes
 * emitidos o recibidos. Analiza la URL, encabezados y elementos del DOM.
 *
 * @returns {string} "EMITIDOS" | "RECIBIDOS" | "DESCONOCIDO"
 */
function detectarOrigenConsulta() {
  const url = (window.location.href || "").toLowerCase();
  const title = (document.title || "").toLowerCase();

  // 1. Analisis por URL (patron mas confiable)
  if (url.includes("emitido") || url.includes("emitid")) {
    return "EMITIDOS";
  }
  if (url.includes("recibido") || url.includes("recibid")) {
    return "RECIBIDOS";
  }

  // 2. Analisis por titulo de pagina
  if (title.includes("emitido") || title.includes("emitid")) {
    return "EMITIDOS";
  }
  if (title.includes("recibido") || title.includes("recibid")) {
    return "RECIBIDOS";
  }

  // 3. Analisis por encabezados visibles en el DOM
  const encabezados = document.querySelectorAll(
    "h1, h2, h3, .ui-panel-title, .ui-fieldset-legend, span.ui-outputlabel"
  );
  for (const el of encabezados) {
    const texto = (el.textContent || "").toLowerCase();
    if (texto.includes("emitido") || texto.includes("emitid")) {
      return "EMITIDOS";
    }
    if (texto.includes("recibido") || texto.includes("recibid")) {
      return "RECIBIDOS";
    }
  }

  // 4. Analisis por breadcrumbs o menus activos de PrimeFaces
  const breadcrumbs = document.querySelectorAll(
    ".ui-breadcrumb li, .ui-menuitem-text, .ui-menuitem-link"
  );
  for (const el of breadcrumbs) {
    const texto = (el.textContent || "").toLowerCase();
    if (texto.includes("emitido") || texto.includes("emitid")) {
      return "EMITIDOS";
    }
    if (texto.includes("recibido") || texto.includes("recibid")) {
      return "RECIBIDOS";
    }
  }

  // 5. Analisis por columnas de la tabla (Receptor/Comprador vs Emisor/Proveedor)
  const columnas = document.querySelectorAll("th, .ui-column-title");
  for (const col of columnas) {
    const texto = (col.textContent || "").toLowerCase();
    if (texto.includes("receptor") || texto.includes("comprador")) {
      return "EMITIDOS";
    }
    if (texto.includes("emisor") || texto.includes("proveedor")) {
      return "RECIBIDOS";
    }
  }

  return "DESCONOCIDO";
}

function extractInvoiceData(pageIndex = getActivePage()) {
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  log("SRI Pro v3.2: Iniciando extraccion robusta...");

  // Detectar contexto de la consulta (emitidos vs recibidos)
  const origenConsulta = detectarOrigenConsulta();
  log(`Contexto detectado: ${origenConsulta}`);

  const invoices = [];

  // SELECTOR OMNIPOTENTE v2.4
  // Ignoramos totalmente los contenedores. Buscamos filas de datos PrimeFaces en TODA la página.
  // data-ri es el atributo estándar de PrimeFaces para Row Index.
  let rows = document.querySelectorAll("tr[data-ri]");

  if (rows.length === 0) {
    log(
      "Advertencia: tr[data-ri] no encontrados. Intentando buscar tablas genéricas..."
    );
    rows = document.querySelectorAll("table tbody tr");
    // Filtramos filas que parezcan tener facturas para evitar cabeceras basura
    // Buscamos filas que tengan al menos una celda con un formato de fecha o número largo
    const filtered = [];
    rows.forEach((r) => {
      if (r.innerText && /\d{2}\/\d{2}\/\d{4}/.test(r.innerText))
        filtered.push(r);
    });
    rows = filtered;
  }

  log(`Filas candidatas encontradas: ${rows.length}`);

  if (rows.length === 0) {
    return {
      invoices: [],
      total: 0,
      logs: logs,
      error:
        "No se encontraron facturas en la pantalla. Asegúrate de haber presionado 'Consultar'.",
    };
  }

  // Helper para limpieza de texto ROBUSTA
  const clean = (el) => {
    if (!el) return "";
    // Usamos innerHTML para reemplazar <br> con espacios y evitar que "RUC<br>Nombre" se convierta en "RUCNombre"
    let html = el.innerHTML || "";
    // Reemplazar saltos de línea visuales con espacio
    html = html.replace(/<br\s*\/?>/gi, " ");
    // Eliminar scripts y estilos por si acaso
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "");
    html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "");
    // Eliminar tags HTML restantes
    let txt = html.replace(/<[^>]*>/g, " ");
    // Normalizar espacios (múltiples espacios a uno solo) y trim
    return txt.replace(/\s+/g, " ").trim();
  };

  rows.forEach((row, index) => {
    try {
      const cells = row.querySelectorAll("td");
      // Si tiene menos de 3 celdas, probablemente no es una fila de datos válida
      if (cells.length < 3) return;

      const cellTexts = Array.from(cells).map((c) => clean(c));

      // DEBUG: Loguear primera fila para diagnóstico
      if (index === 0) {
        log(`Fila 0 (Muestra): [${cellTexts.slice(0, 5).join(" | ")} ...]`);
      }

      // PATRONES
      // RUC: 13 dígitos.
      const rucPattern = /\b(\d{13})\b/;
      // FACTURA: xxx-xxx-xxxxxxxxx
      const invoicePattern = /(\d{3}-\d{3}-\d{9,})/;
      // FECHA: dd/mm/yyyy
      const datePattern = /(\d{2}\/\d{2}\/\d{4})/;
      // DINERO: digitos, puntos, comas.
      const moneyPattern = /^\d{1,3}([.,]\d{3})*[.,]\d{2}$/;

      let numero = "SIN_NUMERO";
      let ruc = "SIN_RUC";
      let razonSocial = "SIN_RAZON";
      let fechaEmision = "SIN_FECHA";
      let fechaAutorizacion = "";

      let valorSinImpuestos = "0.00";
      let iva = "0.00";
      let importeTotal = "0.00";

      // 1. FACTURA
      for (let txt of cellTexts) {
        const m = txt.match(invoicePattern);
        if (m) {
          numero = m[0];
          break;
        }
      }

      // 2. RUC y RAZON SOCIAL
      for (let txt of cellTexts) {
        const m = txt.match(rucPattern);
        if (m) {
          const foundRuc = m[0]; // Grupo 1 es el RUC
          ruc = foundRuc;
          // La razón social suele estar en la misma celda, después del RUC
          // Como reemplazamos <br> con espacio, debería ser "RUC Razon"
          let remainder = txt.replace(foundRuc, "").trim();
          // Limpiar puntuación inicial sobrante
          remainder = remainder.replace(/^[\s-.,]+/, "");
          if (remainder.length > 2) {
            razonSocial = remainder;
          }
          break;
        }
      }

      // 3. FECHAS
      const dates = [];
      for (let txt of cellTexts) {
        const m = txt.match(datePattern);
        if (m) dates.push(m[0]);
      }
      if (dates.length > 0) fechaEmision = dates[0];
      if (dates.length > 1) fechaAutorizacion = dates[1];

      // 4. VALORES
      // Buscamos desde el final columnas que parezcan dinero
      const moneyCols = [];
      for (let i = cellTexts.length - 1; i >= 0; i--) {
        let val = cellTexts[i].replace("$", "").trim();
        // Quitar separadores de miles para check simple?? No, SRI usa . para miles y , para decimales o viceversa
        // Solo validamos formato general
        if (moneyPattern.test(val)) {
          moneyCols.unshift(val);
        }
        if (moneyCols.length >= 3) break;
      }

      if (moneyCols.length >= 1) importeTotal = moneyCols[moneyCols.length - 1];
      if (moneyCols.length >= 2) iva = moneyCols[moneyCols.length - 2];
      if (moneyCols.length >= 3)
        valorSinImpuestos = moneyCols[moneyCols.length - 3];

      // fallback
      let tipoSerie = cellTexts[2] || "";
      let claveAcceso = "";

      // Busqueda robusta de clave de acceso (49 digitos)
      for (let txt of cellTexts) {
        const m = txt.match(/\b\d{49}\b/);
        if (m) {
          claveAcceso = m[0];
          break;
        }
      }
      if (!claveAcceso && cellTexts[3] && cellTexts[3].length >= 49) {
        claveAcceso = cellTexts[3].trim();
      }

      // Tipo de documento segun clave de acceso (posiciones 9 y 10)
      let codDoc = "01";
      if (claveAcceso && claveAcceso.length === 49) {
        codDoc = claveAcceso.substring(8, 10);
      }

      // Estado del comprobante en el portal SRI
      let estadoPortal = "AUTORIZADO";
      for (let txt of cellTexts) {
        const upper = txt.toUpperCase();
        if (upper.includes("ANULAD") || upper.includes("CANCELAD")) {
          estadoPortal = "ANULADO";
          break;
        } else if (upper.includes("NO AUTORIZAD") || upper.includes("RECHAZAD")) {
          estadoPortal = "NO_AUTORIZADO";
          break;
        }
      }

      // XML LINK
      let xmlLinkId = null;
      // Búsqueda prioritaria
      let anchor = row.querySelector('a[id*="lnkXml"]');

      // Búsqueda secundaria por Imagen
      if (!anchor) {
        const img = row.querySelector('img[src*="xml.gif"]');
        if (img) anchor = img.closest("a");
      }

      // Búsqueda terciaria: Texto "XML"
      if (!anchor) {
        const links = row.querySelectorAll("a");
        for (const a of links) {
          if (a.innerText.includes("XML")) {
            anchor = a;
            break;
          }
        }
      }

      if (anchor) {
        if (!anchor.id) {
          anchor.id = "sri_gen_" + Math.random().toString(36).substr(2);
        }
        xmlLinkId = anchor.id;
      }

      if (anchor || (claveAcceso && claveAcceso.length === 49)) {
        invoices.push({
          numero,
          ruc,
          razonSocial,
          tipoSerie,
          claveAcceso,
          codDoc,
          estadoPortal,
          fechaAutorizacion,
          fechaEmision,
          valorSinImpuestos,
          iva,
          importeTotal,
          xmlLinkId,
          origenConsulta,
          rowIndex: index,
          pageIndex: pageIndex,
        });
      }
    } catch (rowError) {
      log(`Error procesando fila ${index}: ${rowError.message}`);
    }
  });

  log(`Proceso completado. ${invoices.length} facturas extraidas (${origenConsulta}).`);
  return { invoices, total: invoices.length, origenConsulta, logs: logs };
}

// Simular clic y manejar descarga
async function downloadSingleXML(linkId, filename) {
  const link = document.getElementById(linkId);
  if (!link) throw new Error("No se encontró el enlace XML en la página actual");

  if (filename) {
    try {
      await chrome.runtime.sendMessage({
        action: "expectDownload",
        filename: filename,
      });
    } catch (e) {
      console.warn("No se pudo avisar al background:", e);
    }
  }

  const href = link.getAttribute("href");

  if (href && href !== "#" && !href.startsWith("javascript:")) {
    const result = await chrome.runtime.sendMessage({
      action: "downloadFile",
      url: link.href,
      filename: filename,
    });
    if (!result?.success) throw new Error(result?.error || "No se inició la descarga");
  } else {
    link.click();
  }

  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

function isLikelySRIXml(text, expectedKey) {
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) return false;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) return false;
  const allowed = ["factura", "autorizacion", "RespuestaAutorizacionComprobante", "notaCredito",
    "notaDebito", "comprobanteRetencion", "liquidacionCompra", "guiaRemision"];
  if (!allowed.includes(doc.documentElement.localName)) return false;
  if (expectedKey) {
    let invoiceDoc = doc;
    const embedded = Array.from(doc.getElementsByTagName("*")).find((el) => el.localName === "comprobante");
    if (embedded) {
      const inner = embedded.textContent.trim();
      if (/<!DOCTYPE|<!ENTITY/i.test(inner)) return false;
      invoiceDoc = new DOMParser().parseFromString(inner, "application/xml");
      if (invoiceDoc.querySelector("parsererror")) return false;
    }
    const keys = Array.from(invoiceDoc.getElementsByTagName("*")).filter((el) => el.localName === "claveAcceso");
    if (keys.length !== 1 || keys[0].textContent.trim() !== expectedKey) return false;
  }
  return true;
}

async function fetchSri(url, options = {}) {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin || target.protocol !== "https:") throw new Error("Destino XML no permitido");
  return fetch(target.href, { ...options, credentials: "include", redirect: "error", signal: AbortSignal.timeout(15000) });
}

// Obtiene el contenido XML en memoria aprovechando la sesion activa del portal SRI
async function fetchXMLContent(linkId, claveAcceso = null) {
  let link = linkId ? document.getElementById(linkId) : null;
  if (link && claveAcceso && !link.closest("tr")?.textContent.includes(claveAcceso)) link = null;

  // Si no se encuentra por linkId, buscar en la fila que contiene la clave de acceso
  if (!link && claveAcceso) {
    const rows = document.querySelectorAll("tr[data-ri], table tbody tr");
    for (const r of rows) {
      if (r.textContent && r.textContent.includes(claveAcceso)) {
        link =
          r.querySelector('a[id*="lnkXml"]') ||
          (r.querySelector('img[src*="xml.gif"]')
            ? r.querySelector('img[src*="xml.gif"]').closest("a")
            : null) ||
          Array.from(r.querySelectorAll("a")).find((a) =>
            (a.textContent || "").includes("XML")
          );
        if (link) break;
      }
    }
  }

  if (!link) return null;

  // 1. Fetch directo por href si es enlace estatico
  const href = link.getAttribute("href");
  if (href && href !== "#" && !href.startsWith("javascript:")) {
    try {
      const res = await fetchSri(link.href);
      if (res.ok) {
        const text = await res.text();
        if (isLikelySRIXml(text, claveAcceso)) {
          return text.trim();
        }
      }
    } catch (e) {
      console.warn("[SRI Pro] Error en fetch directo XML:", e);
    }
  }

  // 2. Submit de formulario JSF/PrimeFaces via application/x-www-form-urlencoded
  const form = link.closest("form") || document.forms[0];
  if (form) {
    try {
      const params = new URLSearchParams();

      // Recorrer todos los elementos del formulario
      const elements = form.elements;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.name && !el.disabled) {
          if (el.type === "radio" || el.type === "checkbox") {
            if (el.checked) params.append(el.name, el.value);
          } else if (el.type !== "submit" && el.type !== "button") {
            params.append(el.name, el.value);
          }
        }
      }

      // Determinar parametro exacto del enlace
      let targetParam = link.id;
      const onclickAttr = link.getAttribute("onclick") || "";
      const match =
        onclickAttr.match(/'([^']+)':'([^']+)'/) ||
        onclickAttr.match(/"([^"]+)":"([^"]+)"/);
      if (match) {
        targetParam = match[1];
      } else if (link.name) {
        targetParam = link.name;
      }

      // Parametros JSF
      params.set(targetParam, targetParam);
      if (link.id && link.id !== targetParam) {
        params.set(link.id, link.id);
      }
      if (form.id) {
        params.set(form.id, form.id);
      }
      params.set("javax.faces.source", targetParam);

      // ViewState fresco
      const vsInput =
        form.querySelector('[name="javax.faces.ViewState"]') ||
        document.querySelector('[name="javax.faces.ViewState"]');
      if (vsInput && vsInput.value) {
        params.set("javax.faces.ViewState", vsInput.value);
      }

      const actionUrl = form.action || window.location.href;

      const res = await fetchSri(actionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        body: params.toString(),
        credentials: "include",
      });

      if (res.ok) {
        const text = await res.text();
        if (isLikelySRIXml(text, claveAcceso)) {
          return text.trim();
        }
      }
    } catch (e) {
      console.warn("[SRI Pro] Error en fetch JSF XML:", e);
    }
  }
  return null;
}

// ─── Navegacion y Paginador PrimeFaces ─────────────────────────────────

function hasNextPage() {
  const nextBtn = document.querySelector(".ui-paginator-next");
  return nextBtn && !nextBtn.classList.contains("ui-state-disabled");
}

function getActivePage() {
  const active = document.querySelector(".ui-paginator-page.ui-state-active");
  return active ? Number.parseInt(active.textContent.trim(), 10) : 1;
}

function tableFingerprint() {
  return Array.from(document.querySelectorAll("tr[data-ri]")).map((r) => r.textContent).join("|");
}

async function waitForTableUpdate(before, expectedPage) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (tableFingerprint() !== before && document.querySelector("tr[data-ri]") &&
        (expectedPage === undefined || getActivePage() === expectedPage)) return true;
  }
  throw new Error("El SRI no confirmó el cambio de página. Vuelve a consultar antes de continuar.");
}

async function clickPage(button, expectedPage) {
  const before = tableFingerprint();
  button.click();
  return waitForTableUpdate(before, expectedPage);
}

async function goToNextPage() {
  const next = document.querySelector(".ui-paginator-next:not(.ui-state-disabled)");
  if (!next) return false;
  return clickPage(next, getActivePage() + 1);
}

async function goToPage(targetPage) {
  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > 10000) return false;
  if (getActivePage() === targetPage) return true;
  if (targetPage < getActivePage()) {
    const first = document.querySelector(".ui-paginator-first:not(.ui-state-disabled)");
    if (!first) return false;
    await clickPage(first, 1);
  }
  for (let attempt = 0; attempt < 10000 && getActivePage() < targetPage; attempt++) {
    const direct = Array.from(document.querySelectorAll(".ui-paginator-page"))
      .find((button) => Number(button.textContent.trim()) === targetPage);
    if (direct) return clickPage(direct, targetPage);
    if (!await goToNextPage()) return false;
  }
  return getActivePage() === targetPage;
}

/**
 * Escanea de forma iterativa todas las paginas de la consulta SRI activa,
 * acumulando comprobantes y deduplicandolos.
 *
 * @async
 * @returns {Promise<{invoices: Array<object>, total: number, origenConsulta: string, totalPages: number}>}
 */
async function scanAllPages() {
  const allInvoices = [];
  const seenKeys = new Set();
  let origenConsultaGlobal = "DESCONOCIDO";

  // Intentar regresar a la primera pagina si no estamos en ella
  const firstBtn = document.querySelector(".ui-paginator-first:not(.ui-state-disabled)");
  if (firstBtn) {
    await clickPage(firstBtn, 1);
  }

  let currentPage = 1;
  const maxPages = 50; // Salvaguarda ISO contra loops

  while (currentPage <= maxPages) {
    const pageData = extractInvoiceData(currentPage);
    if (pageData.origenConsulta && pageData.origenConsulta !== "DESCONOCIDO") {
      origenConsultaGlobal = pageData.origenConsulta;
    }

    if (pageData.invoices && pageData.invoices.length > 0) {
      for (const inv of pageData.invoices) {
        const key = inv.claveAcceso || inv.numero;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          allInvoices.push(inv);
        }
      }
    }

    try {
      chrome.runtime.sendMessage({
        action: "scanAllProgress",
        page: currentPage,
        foundInPage: pageData.invoices.length,
        totalAccumulated: allInvoices.length,
      });
    } catch (e) {}

    if (hasNextPage()) {
      if (currentPage === maxPages) throw new Error("Consulta superior a 50 páginas. Reduce el período para evitar resultados incompletos.");
      const moved = await goToNextPage();
      if (!moved) break;
      currentPage++;
    } else {
      break;
    }
  }

  // Regresar a pagina 1
  try {
    const returnFirst = document.querySelector(".ui-paginator-first:not(.ui-state-disabled)");
    if (returnFirst) {
      await clickPage(returnFirst, 1);
    }
  } catch (e) {}

  return {
    invoices: allInvoices,
    total: allInvoices.length,
    origenConsulta: origenConsultaGlobal,
    totalPages: currentPage,
  };
}

// ─── Listeners de Mensajes ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (syncLeaseUntil && syncLeaseUntil < Date.now()) { portalBusy = false; syncLeaseUntil = 0; }
  if (request.action === "reserveSync") {
    if (portalBusy) { sendResponse({ success: false }); return false; }
    portalBusy = true;
    syncLeaseUntil = Date.now() + 60000;
    sendResponse({ success: true });
    return false;
  }
  if (request.action === "releaseSync") {
    if (syncLeaseUntil) { portalBusy = false; syncLeaseUntil = 0; }
    sendResponse({ success: true });
    return false;
  }
  if (syncLeaseUntil && ["goToPage", "fetchComprobanteXml"].includes(request.action)) syncLeaseUntil = Date.now() + 60000;
  if (request.action === "extractInvoices") {
    sendResponse(extractInvoiceData());
  }

  if (request.action === "scanAllPages") {
    withPortalLock(scanAllPages)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ error: err.message, invoices: [] }));
    return true;
  }

  if (request.action === "goToPage") {
    goToPage(request.page)
      .then((success) => sendResponse({ success }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "downloadSingleXML") {
    downloadSingleXML(request.linkId, request.filename)
      .then((success) => sendResponse({ success }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === "fetchComprobanteXml") {
    fetchXMLContent(request.linkId, request.claveAcceso)
      .then((xml) => sendResponse({ xml }))
      .catch((e) => sendResponse({ xml: null, error: e.message }));
    return true;
  }

  if (["downloadAllPages", "downloadInvoices"].includes(request.action)) {
    if (portalBusy) { sendResponse({ started: false, error: "Espera a que termine la operación del portal" }); return false; }
    withPortalLock(() => request.action === "downloadAllPages" ? processAllPages() : processProvidedInvoices(request.invoices)).catch((error) => chrome.runtime.sendMessage({ action: "downloadError", error: error.message }));
    sendResponse({ started: true });
  }
});

async function processProvidedInvoices(invoices) {
  if (!Array.isArray(invoices) || invoices.length > 10000) throw new Error("Lista de comprobantes no válida");
  let current = 0;
  for (const invoice of invoices) {
    if (!await goToPage(invoice.pageIndex || 1)) throw new Error("No se pudo confirmar la página del XML");
    const { filename } = await chrome.runtime.sendMessage({ action: "getDownloadFilename", invoice });
    await downloadSingleXML(invoice.xmlLinkId, filename);
    chrome.runtime.sendMessage({ action: "updateProgress", current: ++current, total: invoices.length });
  }
}

async function processAllPages() {
  let page = 1;
  let totalProcessed = 0;

  if (!await goToPage(1)) throw new Error("No se pudo volver a la primera página");
  while (true) {
    const data = extractInvoiceData();
    const invoices = data.invoices;

    for (let i = 0; i < invoices.length; i++) {
      const { filename } = await chrome.runtime.sendMessage({ action: "getDownloadFilename", invoice: invoices[i] });
      await downloadSingleXML(invoices[i].xmlLinkId, filename);
      totalProcessed++;

      chrome.runtime.sendMessage({
        action: "updateProgress",
        current: totalProcessed,
        total: "?",
      });
    }

    if (hasNextPage()) {
      if (page >= 50) throw new Error("Consulta superior a 50 páginas. Reduce el período de consulta.");
      await goToNextPage();
      page++;
    } else {
      break;
    }
  }

  chrome.runtime.sendMessage({
    action: "updateProgress",
    current: totalProcessed,
    total: totalProcessed,
  });
}

globalThis.__sriProApi = { extract: extractInvoiceData };
})();
