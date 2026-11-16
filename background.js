import { generateFilename } from "./utils.js";
/**
 * @fileoverview Service Worker (background) para SRI Pro Downloader.
 *
 * Responsabilidades:
 * - Gestionar descargas de archivos XML desde el portal del SRI.
 * - Asignar nombres de archivo personalizados a las descargas.
 * - Orquestar la sincronización en dos fases con EMITE.ec (facturador-ec/api).
 * - Validar URLs y nombres de archivo por seguridad (ISO/IEC 27001).
 *
 * @version 3.6.0
 * @license MIT
 */

import {
  preCheckInvoices,
  ingestChunk,
  updateVoidedInvoices,
} from "./emite_sync.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes y Configuración
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dominios permitidos para descargas (principio de menor privilegio).
 * @const {RegExp}
 */
const ALLOWED_URL_PATTERN = /^https:\/\/srienlinea\.sri\.gob\.ec\//i;

/**
 * Patrón para sanitizar nombres de archivo.
 * @const {RegExp}
 */
const UNSAFE_FILENAME_CHARS = /[<>:"|?*\x00-\x1f]/g;

/**
 * Tiempo máximo en cola para descargas (60 segundos).
 * @const {number}
 */
const QUEUE_ENTRY_TTL_MS = 60_000;

/**
 * Tamaño de micro-lote para ingesta segura sin timeout.
 * @const {number}
 */
const INGEST_CHUNK_SIZE = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Estado Interno de Descargas
// ─────────────────────────────────────────────────────────────────────────────

const filenameQueue = new Map();
const storageReady = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const { emiteSyncState, lastEmiteSyncResult } = await chrome.storage.local.get(["emiteSyncState", "lastEmiteSyncResult"]);
  if (emiteSyncState?.status === "IN_PROGRESS") {
    await chrome.storage.local.set({
      emiteSyncState: { status: "ERROR", progress: 0, error: "Chrome interrumpió la sincronización. Escanea y vuelve a sincronizar; se comprobarán los duplicados." },
      ...(lastEmiteSyncResult ? { lastEmiteSyncResult: { ...lastEmiteSyncResult, enProgreso: false } } : {}),
    });
  }
})();
let syncRunning = false;

function isAllowedUrl(url) {
  if (!url || typeof url !== "string") return false;
  return ALLOWED_URL_PATTERN.test(url);
}

function sanitizeFilename(filename) {
  if (!filename || typeof filename !== "string") return "";
  let safe = filename.replace(/\\/g, "/").split("/")
    .filter((part) => part && part !== "." && part !== "..").join("/");
  safe = safe.replace(UNSAFE_FILENAME_CHARS, "");
  return safe.trim();
}

function enqueueFilename(key, filename) {
  filenameQueue.set(key, {
    filename,
    timestamp: Date.now(),
  });
}

function dequeueFilename(downloadId) {
  const now = Date.now();
  for (const [key, entry] of filenameQueue.entries()) {
    if (now - entry.timestamp > QUEUE_ENTRY_TTL_MS) {
      filenameQueue.delete(key);
    }
  }

  if (filenameQueue.has(downloadId)) {
    const entry = filenameQueue.get(downloadId);
    filenameQueue.delete(downloadId);
    return entry.filename;
  }

  if (filenameQueue.has("pending")) {
    const entry = filenameQueue.get("pending");
    filenameQueue.delete("pending");
    return entry.filename;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orquestador de Sincronización con EMITE.ec
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta el flujo completo de sincronizacion diferencial en segundo plano.
 * Tolerante al cierre del popup gracias a la persistencia en chrome.storage.local.
 * Soporta tanto comprobantes recibidos como emitidos.
 *
 * @async
 * @param {number} tabId - ID de la pestana activa de sri.gob.ec.
 * @param {Array<object>} [providedInvoices=null] - Comprobantes ya escaneados por el popup.
 * @param {string} [origenConsulta="RECIBIDOS"] - Contexto: "EMITIDOS" o "RECIBIDOS".
 */
async function executeEmiteSync(tabId, providedInvoices = null, origenConsulta = "RECIBIDOS", frameId = 0) {
  const send = (message) => chrome.tabs.sendMessage(tabId, message, { frameId });
  const reserved = await send({ action: "reserveSync" });
  if (!reserved?.success) throw new Error("El portal está ocupado descargando o escaneando. Espera a que termine.");
  try {
    return await runEmiteSync(tabId, providedInvoices, origenConsulta, frameId);
  } finally {
    try { await send({ action: "goToPage", page: 1 }); } catch (_) { /* La pestaña puede haberse cerrado. */ }
    try { await send({ action: "releaseSync" }); } catch (_) { /* La reserva expira si se interrumpe Chrome. */ }
  }
}

async function runEmiteSync(tabId, providedInvoices = null, origenConsulta = "RECIBIDOS", frameId = 0) {
  const sendSriMessage = (message) => chrome.tabs.sendMessage(tabId, message, { frameId });
  const esEmitidosInicial = origenConsulta === "EMITIDOS";
  const etiquetaInicial = esEmitidosInicial ? "emitidos" : "recibidos";
  console.log(`[SRI Pro] Iniciando sincronizacion de ${etiquetaInicial} con EMITE.ec en pestana:`, tabId);

  await storageReady;
  // 1. Verificar estado y credenciales
  await chrome.storage.local.set({
    emiteSyncState: {
      status: "IN_PROGRESS",
      progress: 5,
      step: "Consultando credenciales...",
      error: null,
    },
  });

  const storage = await chrome.storage.local.get([
    "emiteApiUrl",
    "emiteApiKey",
  ]);

  const apiUrl = storage.emiteApiUrl || "https://api.emite.ec";
  const apiKey = storage.emiteApiKey || "";

  if (!apiKey || apiKey.trim().length === 0) {
    await chrome.storage.local.set({
      emiteSyncState: {
        status: "ERROR",
        progress: 0,
        step: "Faltan credenciales",
        error: "Debes configurar tu API Key de EMITE.ec en el panel de Opciones.",
      },
    });
    return;
  }

  // 2. Extraer comprobantes (prioridad: comprobantes transferidos desde el popup)
  let rawInvoices = [];
  if (Array.isArray(providedInvoices) && providedInvoices.length > 0) {
    rawInvoices = providedInvoices;
    console.log(`[SRI Pro] Usando ${rawInvoices.length} comprobantes proporcionados por el popup.`);
  } else if (tabId) {
    await chrome.storage.local.set({
      emiteSyncState: {
        status: "IN_PROGRESS",
        progress: 15,
        step: "Extrayendo comprobantes de la pantalla...",
        error: null,
      },
    });

    try {
      const response = await sendSriMessage({
        action: "extractInvoices",
      });
      if (response && response.invoices && response.invoices.length > 0) {
        rawInvoices = response.invoices;
      }
    } catch (err) {
      console.warn("[SRI Pro] Error al comunicarse con content script:", err);
    }

  }

  // Deduplicar comprobantes por clave de acceso o número
  if (rawInvoices && rawInvoices.length > 0) {
    const seen = new Set();
    rawInvoices = rawInvoices.filter((inv) => {
      const key = inv.claveAcceso || inv.numero;
      if (!key || key === "SIN_NUMERO") return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (!rawInvoices || rawInvoices.length === 0) {
    await chrome.storage.local.set({
      emiteSyncState: {
        status: "ERROR",
        progress: 0,
        step: "Sin comprobantes",
        error:
          "No se detectaron comprobantes en la pantalla. Realiza una consulta en el portal del SRI primero y presiona 'Escanear Página Actual'.",
      },
    });
    return;
  }

  // Determinar si la sincronización corresponde a comprobantes emitidos o recibidos
  let tipoSincronizacion = origenConsulta;
  if (!tipoSincronizacion || tipoSincronizacion === "DESCONOCIDO") {
    const conOrigen = rawInvoices.find(
      (inv) => inv.origenConsulta && inv.origenConsulta !== "DESCONOCIDO"
    );
    tipoSincronizacion = conOrigen ? conOrigen.origenConsulta : "DESCONOCIDO";
  }
  if (!["RECIBIDOS", "EMITIDOS"].includes(tipoSincronizacion)) throw new Error("No se pudo identificar si la consulta es de recibidos o emitidos");
  const esEmitidos = tipoSincronizacion === "EMITIDOS";
  const etiquetaSinc = esEmitidos ? "emitidos" : "recibidos";

  console.log(
    `[SRI Pro] Comprobantes detectados: ${rawInvoices.length} (${etiquetaSinc}). Iniciando Fase 1: Pre-check.`
  );

  // 3. Fase 1: Pre-check diferencial (inicializar estado en tiempo real)
  await chrome.storage.local.set({
    lastEmiteSyncResult: {
      fecha: new Date().toISOString(),
      totalAnalizados: rawInvoices.length,
      totalSincronizadas: 0,
      totalDuplicadas: 0,
      totalAnuladas: 0,
      totalFallidas: 0,
      notasCredito: 0,
      fallidosDetalle: [],
      enProgreso: true,
      loteActual: 0,
      totalLotes: 0,
      tipoSincronizacion,
    },
    emiteSyncState: {
      status: "IN_PROGRESS",
      progress: 20,
      step: `Verificando ${rawInvoices.length} comprobantes ${etiquetaSinc} en EMITE.ec...`,
      error: null,
    },
  });

  const preCheckRes = await preCheckInvoices(
    apiUrl,
    apiKey,
    rawInvoices,
    tipoSincronizacion
  );
  if (!preCheckRes.success) {
    await chrome.storage.local.set({
      emiteSyncState: {
        status: "ERROR",
        progress: 0,
        step: "Error en pre-check",
        error: preCheckRes.error,
      },
    });
    return;
  }

  const {
    duplicadas = [],
    por_sincronizar = [],
    anuladas_detectadas = [],
  } = preCheckRes.data;

  const totalLotes = Math.ceil(por_sincronizar.length / INGEST_CHUNK_SIZE);

  // Actualizar inmediatamente tras pre-check para mostrar analizados y duplicados en vivo
  await chrome.storage.local.set({
    lastEmiteSyncResult: {
      fecha: new Date().toISOString(),
      totalAnalizados: rawInvoices.length,
      totalSincronizadas: 0,
      totalDuplicadas: duplicadas.length,
      totalAnuladas: anuladas_detectadas.length,
      totalFallidas: 0,
      notasCredito: 0,
      fallidosDetalle: [],
      enProgreso: por_sincronizar.length > 0,
      loteActual: 0,
      totalLotes: totalLotes,
    },
    emiteSyncState: {
      status: "IN_PROGRESS",
      progress: 30,
      step: `Pre-check: ${duplicadas.length} duplicadas, ${por_sincronizar.length} nuevas por sincronizar.`,
      error: null,
    },
  });

  console.log(
    `[SRI Pro] Pre-check: ${duplicadas.length} duplicadas, ${por_sincronizar.length} nuevas, ${anuladas_detectadas.length} anuladas.`
  );

  // 4. Actualizar facturas anuladas si existen
  if (anuladas_detectadas.length > 0) {
    await chrome.storage.local.set({
      emiteSyncState: {
        status: "IN_PROGRESS",
        progress: 35,
        step: `Actualizando ${anuladas_detectadas.length} facturas anuladas...`,
        error: null,
      },
    });
    const clavesAnuladas = anuladas_detectadas.map((a) => a.clave_acceso);
    for (let i = 0; i < clavesAnuladas.length; i += 50) {
      const result = await updateVoidedInvoices(apiUrl, apiKey, clavesAnuladas.slice(i, i + 50), tipoSincronizacion);
      if (!result.success) throw new Error(result.error || "No se pudieron actualizar las anuladas");
    }
  }

  // 5. Fase 2: Ingesta en micro-lotes
  const totalNuevas = por_sincronizar.length;
  const guardadosTotal = [];
  const fallidosTotal = [];

  if (totalNuevas === 0) {
    // Todas eran duplicadas o ya sincronizadas
    const finalResult = {
      fecha: new Date().toISOString(),
      totalAnalizados: rawInvoices.length,
      totalSincronizadas: 0,
      totalDuplicadas: duplicadas.length,
      totalAnuladas: anuladas_detectadas.length,
      totalFallidas: 0,
      notasCredito: 0,
      fallidosDetalle: [],
    };

    await chrome.storage.local.set({
      lastEmiteSyncResult: finalResult,
      emiteSyncState: {
        status: "SUCCESS",
        progress: 100,
        step: "Sincronización completada: No había comprobantes nuevos.",
        error: null,
      },
    });
    return;
  }

  // Mapeo rápido de claves a comprobantes crudos para acceder a xmlLinkId
  const keyToInvoiceMap = new Map();
  rawInvoices.forEach((inv) => {
    if (inv.claveAcceso) {
      keyToInvoiceMap.set(inv.claveAcceso, inv);
    }
  });

  // Ordenar comprobantes por página de origen para agrupar peticiones por vista de tabla
  por_sincronizar.sort((a, b) => {
    const invA = keyToInvoiceMap.get(a.clave_acceso);
    const invB = keyToInvoiceMap.get(b.clave_acceso);
    const pageA = (invA && invA.pageIndex) || 1;
    const pageB = (invB && invB.pageIndex) || 1;
    return pageA - pageB;
  });

  // Dividir en chunks de tamaño seguro
  const chunks = [];
  for (const item of por_sincronizar) {
    const page = keyToInvoiceMap.get(item.clave_acceso)?.pageIndex || 1;
    const last = chunks[chunks.length - 1];
    const lastPage = last && (keyToInvoiceMap.get(last[0])?.pageIndex || 1);
    if (!last || last.length >= INGEST_CHUNK_SIZE || page !== lastPage) chunks.push([]);
    chunks[chunks.length - 1].push(item.clave_acceso);
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkKeys = chunks[idx];
    const chunkPercent = Math.round(
      40 + ((idx + 1) / chunks.length) * 55
    );

    // Navegar a la página correspondiente en la pestaña activa si es necesario
    const firstClave = chunkKeys[0];
    const firstInv = keyToInvoiceMap.get(firstClave);
    const targetPage = (firstInv && firstInv.pageIndex) || 1;
    if (tabId && targetPage > 0) {
      try {
        const navigation = await sendSriMessage({
          action: "goToPage",
          page: targetPage,
        });
        if (!navigation?.success) throw new Error(navigation?.error || "Página no confirmada");
      } catch (navErr) {
        throw new Error("No se pudo navegar a la página del lote: " + navErr.message);
      }
    }

    await chrome.storage.local.set({
      emiteSyncState: {
        status: "IN_PROGRESS",
        progress: chunkPercent,
        step: `Ingestando lote ${idx + 1} de ${chunks.length} (${chunkKeys.length} comprobantes)...`,
        error: null,
      },
    });

    // Intentar extraer el XML en memoria desde la sesión del portal SRI para evitar SOAP
    const chunkPayload = [];
    for (const clave of chunkKeys) {
      const inv = keyToInvoiceMap.get(clave);
      let xmlContent = null;

      // Intento 1: Vía mensajería directa con content script
      if (inv && tabId) {
        try {
          const xmlResp = await sendSriMessage({
            action: "fetchComprobanteXml",
            linkId: inv.xmlLinkId,
            claveAcceso: clave,
          });
          if (xmlResp && xmlResp.xml) {
            xmlContent = xmlResp.xml;
          }
        } catch (e) {
          // Se informa como fallido si no hay XML válido
        }
      }

      if (!xmlContent) {
        fallidosTotal.push({ clave_acceso: clave, error: "No se pudo obtener el XML en la sesión del SRI. Vuelve a consultar y reintenta." });
        continue;
      }

      chunkPayload.push({
        clave_acceso: clave,
        xml_content: xmlContent,
      });
    }

    const chunkRes = chunkPayload.length ? await ingestChunk(
      apiUrl,
      apiKey,
      chunkPayload,
      2,
      tipoSincronizacion
    ) : { success: true, data: { guardados: [], fallidos: [] } };
    if (chunkRes.success && chunkRes.data) {
      if (Array.isArray(chunkRes.data.guardados)) {
        guardadosTotal.push(...chunkRes.data.guardados);
      }
      if (Array.isArray(chunkRes.data.fallidos)) {
        fallidosTotal.push(...chunkRes.data.fallidos);
      }
    } else {
      // Chunk completo fallo
      chunkPayload.map((item) => item.clave_acceso).forEach((k) =>
        fallidosTotal.push({ clave_acceso: k, error: chunkRes.error || "Fallo de conexión" })
      );
    }

    const currentNotasCredito = guardadosTotal.filter((g) => g.cod_doc === "04").length;

    // Actualizar en tiempo real el resultado en almacenamiento local tras cada lote
    const liveSnapshot = {
      fecha: new Date().toISOString(),
      totalAnalizados: rawInvoices.length,
      totalSincronizadas: guardadosTotal.length,
      totalDuplicadas: duplicadas.length,
      totalAnuladas: anuladas_detectadas.length,
      totalFallidas: fallidosTotal.length,
      notasCredito: currentNotasCredito,
      fallidosDetalle: [...fallidosTotal],
      enProgreso: true,
      loteActual: idx + 1,
      totalLotes: chunks.length,
      tipoSincronizacion,
    };

    await chrome.storage.local.set({
      lastEmiteSyncResult: liveSnapshot,
      emiteSyncState: {
        status: "IN_PROGRESS",
        progress: chunkPercent,
        step: `Lote ${idx + 1} de ${chunks.length}: ${guardadosTotal.length} sincronizadas, ${fallidosTotal.length} fallidas...`,
        error: null,
      },
    });

    // Breve pausa preventiva entre micro-lotes para descongestionar conexiones
    await new Promise((r) => setTimeout(r, 600));
  }

  // Restaurar la pestaña a la página 1 si se navegó durante la sincronización
  if (tabId) {
    try {
      await sendSriMessage({ action: "goToPage", page: 1 });
    } catch (e) {}
  }

  // Contar notas de crédito guardadas definitivas
  const notasCreditoCount = guardadosTotal.filter(
    (g) => g.cod_doc === "04"
  ).length;

  const finalResult = {
    fecha: new Date().toISOString(),
    totalAnalizados: rawInvoices.length,
    totalSincronizadas: guardadosTotal.length,
    totalDuplicadas: duplicadas.length,
    totalAnuladas: anuladas_detectadas.length,
    totalFallidas: fallidosTotal.length,
    notasCredito: notasCreditoCount,
    fallidosDetalle: fallidosTotal,
    enProgreso: false,
    loteActual: chunks.length,
    totalLotes: chunks.length,
    tipoSincronizacion,
  };

  await chrome.storage.local.set({
    lastEmiteSyncResult: finalResult,
    emiteSyncState: {
      status: fallidosTotal.length ? "PARTIAL" : "SUCCESS",
      progress: 100,
      step: `Sincronización completada: ${guardadosTotal.length} nuevas, ${duplicadas.length} duplicadas.`,
      error: null,
    },
  });

  console.log("[SRI Pro] Sincronización finalizada.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Manejo de Mensajes entre Componentes
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromPopup = sender.url === chrome.runtime.getURL("popup.html");
  const fromSri = sender.tab && isAllowedUrl(sender.url || "");
  if (!fromPopup && !fromSri) return false;
  if (request.action === "getDownloadFilename" && fromSri) {
    storageReady.then(() => chrome.storage.local.get("downloadFolder")).then(({ downloadFolder }) => {
      const name = generateFilename(request.invoice || {});
      sendResponse({ filename: sanitizeFilename(downloadFolder ? `${downloadFolder}/${name}` : name) });
    });
    return true;
  }
  if (request.action === "downloadFile") {
    handleDownload(request.url, request.filename, sendResponse);
    return true;
  }

  if (request.action === "expectDownload") {
    const safeName = sanitizeFilename(request.filename);
    if (safeName) {
      enqueueFilename("pending", safeName);

    }
    sendResponse({ received: true });
    return false;
  }

  if (request.action === "startEmiteSync") {
    if (!fromPopup || syncRunning) {
      sendResponse({ started: false, error: "Sincronización no disponible o ya en curso" });
      return false;
    }
    syncRunning = true;
    sendResponse({ started: true });
    chrome.tabs.get(request.tabId).then((tab) => {
      if (!isAllowedUrl(tab.url)) throw new Error("La pestaña debe pertenecer al portal SRI seguro");
      return executeEmiteSync(request.tabId, request.invoices, request.origenConsulta, request.frameId || 0);
    })
      .catch((err) => {
        console.error("[SRI Pro] Error fatal en executeEmiteSync:", err);
        chrome.storage.local.set({
          emiteSyncState: {
            status: "ERROR",
            progress: 0,
            step: "Error inesperado",
            error: err.message,
          },
        });
      }).finally(() => { syncRunning = false; });
    return false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Interceptor de Nombres de Archivo para Descargas
// ─────────────────────────────────────────────────────────────────────────────

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!isAllowedUrl(item.url) && !isAllowedUrl(item.referrer) &&
      !(typeof item.url === "string" && item.url.startsWith("blob:https://srienlinea.sri.gob.ec/"))) { suggest(); return; }
  const customFilename = dequeueFilename(item.id);

  if (customFilename) {

    suggest({
      filename: customFilename,
      conflictAction: "uniquify",
    });
  } else {
    suggest();
  }
});

function handleDownload(url, filename, sendResponse) {
  if (!isAllowedUrl(url)) {
    console.error(`[SRI Pro] URL rechazada por política de seguridad: ${url}`);
    sendResponse({
      success: false,
      error: `URL no permitida. Solo se aceptan descargas desde sri.gob.ec.`,
    });
    return;
  }

  const safeName = sanitizeFilename(filename);

  chrome.downloads.download(
    {
      url: url,
      filename: safeName || undefined,
      conflictAction: "uniquify",
      saveAs: false,
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
      } else {
        if (safeName) {
          enqueueFilename(downloadId, safeName);
        }
        sendResponse({ success: true, downloadId: downloadId });
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de Vida de Instalación / Actualización
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    console.log("[SRI Pro] Extensión instalada correctamente (v3.6.0).");
  } else if (details.reason === "update") {
    console.log(
      `[SRI Pro] Extensión actualizada desde v${details.previousVersion} a v3.6.0.`
    );
    filenameQueue.clear();
  }

  // Asegurar que las pestañas de SRI abiertas antes de la actualización reciban content.js
  try {
    const tabs = await chrome.tabs.query({ url: "https://srienlinea.sri.gob.ec/*" });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ["content.js"],
          })
          .catch((err) => {
            console.warn(
              "[SRI Pro] Auto-inyección preventiva en pestaña SRI omitida:",
              tab.id,
              err.message
            );
          });
      }
    }
  } catch (err) {
    console.warn("[SRI Pro] Error al inicializar pestañas SRI:", err);
  }
});
