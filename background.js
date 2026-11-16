/**
 * @fileoverview Service Worker (background) para SRI Pro Downloader.
 *
 * Responsabilidades:
 * - Gestionar descargas de archivos XML desde el portal del SRI.
 * - Asignar nombres de archivo personalizados a las descargas.
 * - Orquestar la sincronización en dos fases con EMITE.ec (facturador-ec/api).
 * - Validar URLs y nombres de archivo por seguridad (ISO/IEC 27001).
 *
 * @version 3.3.0
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
const ALLOWED_URL_PATTERN = /^https?:\/\/([a-z0-9-]+\.)*sri\.gob\.ec\//i;

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
const INGEST_CHUNK_SIZE = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Estado Interno de Descargas
// ─────────────────────────────────────────────────────────────────────────────

const filenameQueue = new Map();

function isAllowedUrl(url) {
  if (!url || typeof url !== "string") return false;
  return ALLOWED_URL_PATTERN.test(url);
}

function sanitizeFilename(filename) {
  if (!filename || typeof filename !== "string") return "";
  let safe = filename.replace(/\.\.[/\\]/g, "");
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
 * Ejecuta el flujo completo de sincronización diferencial en segundo plano.
 * Tolerante al cierre del popup gracias a la persistencia en chrome.storage.local.
 *
 * @async
 * @param {number} tabId - ID de la pestaña activa de sri.gob.ec.
 * @param {Array<object>} [providedInvoices=null] - Comprobantes ya escaneados por el popup.
 */
async function executeEmiteSync(tabId, providedInvoices = null) {
  console.log("[SRI Pro] Iniciando sincronización con EMITE.ec en pestaña:", tabId);

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
      const response = await chrome.tabs.sendMessage(tabId, {
        action: "extractInvoices",
      });
      if (response && response.invoices && response.invoices.length > 0) {
        rawInvoices = response.invoices;
      }
    } catch (err) {
      console.warn("[SRI Pro] Error al comunicarse con content script:", err);
    }
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

  console.log(
    `[SRI Pro] Comprobantes detectados: ${rawInvoices.length}. Iniciando Fase 1: Pre-check.`
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
    },
    emiteSyncState: {
      status: "IN_PROGRESS",
      progress: 20,
      step: `Verificando ${rawInvoices.length} comprobantes en EMITE.ec...`,
      error: null,
    },
  });

  const preCheckRes = await preCheckInvoices(apiUrl, apiKey, rawInvoices);
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
    await updateVoidedInvoices(apiUrl, apiKey, clavesAnuladas);
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

  // Dividir en chunks de 5 claves
  const chunks = [];
  for (let i = 0; i < por_sincronizar.length; i += INGEST_CHUNK_SIZE) {
    chunks.push(
      por_sincronizar.slice(i, i + INGEST_CHUNK_SIZE).map((item) => item.clave_acceso)
    );
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkKeys = chunks[idx];
    const chunkPercent = Math.round(
      40 + ((idx + 1) / chunks.length) * 55
    );

    await chrome.storage.local.set({
      emiteSyncState: {
        status: "IN_PROGRESS",
        progress: chunkPercent,
        step: `Ingestando lote ${idx + 1} de ${chunks.length} (${chunkKeys.length} comprobantes)...`,
        error: null,
      },
    });

    // Intentar extraer el XML en memoria desde la sesion del portal SRI para evitar SOAP
    const chunkPayload = [];
    for (const clave of chunkKeys) {
      const inv = keyToInvoiceMap.get(clave);
      let xmlContent = null;
      if (inv && inv.xmlLinkId && tabId) {
        try {
          const xmlResp = await chrome.tabs.sendMessage(tabId, {
            action: "fetchComprobanteXml",
            linkId: inv.xmlLinkId,
          });
          if (xmlResp && xmlResp.xml) {
            xmlContent = xmlResp.xml;
          }
        } catch (e) {
          // Tab inaccesible o error de comunicacion
        }
      }
      chunkPayload.push({
        clave_acceso: clave,
        xml_content: xmlContent,
      });
    }

    const chunkRes = await ingestChunk(apiUrl, apiKey, chunkPayload);
    if (chunkRes.success && chunkRes.data) {
      if (Array.isArray(chunkRes.data.guardados)) {
        guardadosTotal.push(...chunkRes.data.guardados);
      }
      if (Array.isArray(chunkRes.data.fallidos)) {
        fallidosTotal.push(...chunkRes.data.fallidos);
      }
    } else {
      // Chunk completo fallo
      chunkKeys.forEach((k) =>
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
  };

  await chrome.storage.local.set({
    lastEmiteSyncResult: finalResult,
    emiteSyncState: {
      status: "SUCCESS",
      progress: 100,
      step: `Sincronización completada: ${guardadosTotal.length} nuevas, ${duplicadas.length} duplicadas.`,
      error: null,
    },
  });

  console.log("[SRI Pro] Sincronización finalizada exitosamente:", finalResult);
}

// ─────────────────────────────────────────────────────────────────────────────
// Manejo de Mensajes entre Componentes
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "downloadFile") {
    handleDownload(request.url, request.filename, sendResponse);
    return true;
  }

  if (request.action === "expectDownload") {
    const safeName = sanitizeFilename(request.filename);
    if (safeName) {
      enqueueFilename("pending", safeName);
      console.log("[SRI Pro] Descarga esperada encolada:", safeName);
    }
    sendResponse({ received: true });
    return false;
  }

  if (request.action === "startEmiteSync") {
    executeEmiteSync(request.tabId, request.invoices)
      .then(() => sendResponse({ started: true }))
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
      });
    return true; // Respuesta asíncrona
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Interceptor de Nombres de Archivo para Descargas
// ─────────────────────────────────────────────────────────────────────────────

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const customFilename = dequeueFilename(item.id);

  if (customFilename) {
    console.log(
      `[SRI Pro] Asignando nombre "${customFilename}" a descarga #${item.id}`
    );
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
    console.log("[SRI Pro] Extensión instalada correctamente (v3.3.3).");
  } else if (details.reason === "update") {
    console.log(
      `[SRI Pro] Extensión actualizada desde v${details.previousVersion} a v3.3.3.`
    );
    filenameQueue.clear();
  }

  // Asegurar que las pestañas de SRI abiertas antes de la actualización reciban content.js
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.sri.gob.ec/*" });
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
