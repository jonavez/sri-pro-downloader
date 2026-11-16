// content.js - Lógica de extracción e interacción con la página (v3.1)

function extractInvoiceData() {
  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  log("SRI Pro v3.1: Iniciando extracción robusta...");

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
          rowIndex: index,
        });
      }
    } catch (rowError) {
      log(`Error procesando fila ${index}: ${rowError.message}`);
    }
  });

  log(`Proceso completado. ${invoices.length} facturas extraídas.`);
  return { invoices, total: invoices.length, logs: logs };
}

// Simular clic y manejar descarga
async function downloadSingleXML(linkId, filename) {
  const link = document.getElementById(linkId);
  if (!link) return false;

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
    chrome.runtime.sendMessage({
      action: "downloadFile",
      url: link.href,
      filename: filename,
    });
  } else {
    link.click();
  }

  await new Promise((r) => setTimeout(r, 2000));
  return true;
}

function isLikelySRIXml(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("<?xml") ||
    lower.includes("<factura") ||
    lower.includes("<comprobante") ||
    lower.includes("<autorizacion") ||
    lower.includes("<notacredito") ||
    lower.includes("<notadebito") ||
    lower.includes("<comprobanteretencion") ||
    lower.includes("<liquidacioncompra") ||
    lower.includes("<guiaremision")
  );
}

// Obtiene el contenido XML en memoria aprovechando la sesion activa del portal SRI
async function fetchXMLContent(linkId) {
  const link = document.getElementById(linkId);
  if (!link) return null;

  const href = link.getAttribute("href");
  if (href && href !== "#" && !href.startsWith("javascript:")) {
    try {
      const res = await fetch(link.href, { credentials: "include" });
      if (res.ok) {
        const text = await res.text();
        if (isLikelySRIXml(text)) {
          return text;
        }
      }
    } catch (e) {
      console.warn("[SRI Pro] Error en fetch directo XML:", e);
    }
  }

  // En PrimeFaces/Mojarra, el link ejecuta un submit de formulario
  const form = link.closest("form") || document.forms[0];
  if (form) {
    try {
      const formData = new FormData(form);

      // Determinar parametro exacto: desde onclick (patron jsfcljs o PrimeFaces.ab) o name o id
      let targetParam = link.id;
      const onclickAttr = link.getAttribute("onclick") || "";
      const match = onclickAttr.match(/'([^']+)':'([^']+)'/) || onclickAttr.match(/"([^"]+)":"([^"]+)"/);
      if (match) {
        targetParam = match[1];
      } else if (link.name) {
        targetParam = link.name;
      }

      formData.set(targetParam, targetParam);
      if (link.id && link.id !== targetParam) {
        formData.set(link.id, link.id);
      }
      if (form.id) {
        formData.set(form.id, form.id);
      }
      formData.set("javax.faces.source", targetParam);

      // Asegurar ViewState fresco del DOM si existe
      const vsInput = form.querySelector('[name="javax.faces.ViewState"]') || document.querySelector('[name="javax.faces.ViewState"]');
      if (vsInput && vsInput.value) {
        formData.set("javax.faces.ViewState", vsInput.value);
      }

      const actionUrl = form.action || window.location.href;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(actionUrl, {
        method: "POST",
        body: formData,
        credentials: "include",
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const text = await res.text();
        if (isLikelySRIXml(text)) {
          return text;
        }
      }
    } catch (e) {
      console.warn("[SRI Pro] Error en fetch JSF XML:", e);
    }
  }
  return null;
}

// Navegación
function hasNextPage() {
  const nextBtn = document.querySelector(".ui-paginator-next");
  return nextBtn && !nextBtn.classList.contains("ui-state-disabled");
}

async function goToNextPage() {
  const nextBtn = document.querySelector(".ui-paginator-next");
  if (nextBtn) {
    nextBtn.click();
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Listeners
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractInvoices") {
    sendResponse(extractInvoiceData());
  }

  if (request.action === "downloadSingleXML") {
    downloadSingleXML(request.linkId, request.filename)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === "fetchComprobanteXml") {
    fetchXMLContent(request.linkId)
      .then((xml) => sendResponse({ xml }))
      .catch((e) => sendResponse({ xml: null, error: e.message }));
    return true;
  }

  if (request.action === "downloadAllPages") {
    processAllPages();
    sendResponse({ started: true });
  }
});

async function processAllPages() {
  let page = 1;
  let totalProcessed = 0;

  let utils;
  try {
    utils = await import(chrome.runtime.getURL("utils.js"));
  } catch (e) {
    console.error("Error importando utils:", e);
  }

  let downloadFolder = "";
  try {
    const storage = await chrome.storage.local.get(["downloadFolder"]);
    downloadFolder = storage.downloadFolder || "";
  } catch (e) {
    console.warn("Error leyendo storage:", e);
  }

  while (true) {
    const data = extractInvoiceData();
    const invoices = data.invoices;

    for (let i = 0; i < invoices.length; i++) {
      let filename = "";
      if (utils) {
        filename = utils.generateFilename(invoices[i]);
        if (downloadFolder) {
          filename = `${downloadFolder}/${filename}`;
        }
      }

      await downloadSingleXML(invoices[i].xmlLinkId, filename);
      totalProcessed++;

      chrome.runtime.sendMessage({
        action: "updateProgress",
        current: totalProcessed,
        total: "?",
      });
    }

    if (hasNextPage()) {
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
