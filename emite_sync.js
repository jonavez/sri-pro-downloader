import { parseSriAmount } from "./utils.js";
/**
 * @fileoverview Cliente de sincronización para la API de EMITE.ec.
 *
 * Encapsula la comunicación segura entre la extensión SRI Pro Downloader
 * y el backend de EMITE.ec (facturador-ec/api), implementando el protocolo
 * diferencial de dos fases con micro-lotes (Chunked Differential Sync).
 *
 * Controles de referencia (sin certificación):
 * - ISO/IEC 27001 (Seguridad de la información y menor privilegio)
 * - ISO/IEC 25010 (Mantenibilidad y tolerancia a fallos)
 *
 * @version 1.0.0
 * @module emite_sync
 */

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Normaliza la URL base de la API eliminando barras inclinadas al final.
 *
 * @param {string} url - URL base configurada.
 * @returns {string} URL normalizada sin barra final.
 */
export function normalizeApiUrl(url) {
  if (!url || typeof url !== "string") return "https://api.emite.ec";
  let clean = url.trim();
  while (clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }
  if (clean !== "https://api.emite.ec") {
    throw new Error("Solo se permite la API oficial https://api.emite.ec");
  }
  return clean;
}

/**
 * Ejecuta una petición HTTP autenticada con timeout abortable.
 *
 * @async
 * @param {string} endpoint - Ruta del endpoint (ej. /api/v1/...).
 * @param {string} apiUrl - URL base de la API.
 * @param {string} apiKey - Llave de autenticación API Key.
 * @param {RequestInit} [options={}] - Opciones de fetch.
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
async function fetchEmiteApi(endpoint, apiUrl, apiKey, options = {}) {
  let baseUrl;
  try { baseUrl = normalizeApiUrl(apiUrl); } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  const targetUrl = `${baseUrl}${endpoint}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-API-Key": (apiKey || "").trim(),
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(targetUrl, {
      ...options,
      headers,
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });

    let responseData;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseData = await response.json();
    } else {
      responseData = { detail: await response.text() };
    }

    if (!response.ok) {
      const errorMessage =
        (responseData && responseData.detail) ||
        `Error HTTP ${response.status}: ${response.statusText}`;
      return { ok: false, status: response.status, error: errorMessage };
    }

    return { ok: true, status: response.status, data: responseData };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        error: "Tiempo de espera agotado al conectar con el servidor de EMITE.ec",
      };
    }
    return {
      ok: false,
      status: 0,
      error: `Error de red al conectar con ${targetUrl}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Comprueba las credenciales contra EMITE.ec y obtiene los datos del tenant.
 *
 * @async
 * @param {string} apiUrl - URL del backend.
 * @param {string} apiKey - Llave de API.
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function testConnection(apiUrl, apiKey) {
  if (!apiKey || apiKey.trim().length === 0) {
    return { success: false, error: "Debes ingresar una API Key válida" };
  }

  const res = await fetchEmiteApi(
    "/api/v1/facturas-recibidas/sincronizar/verificar-conexion",
    apiUrl,
    apiKey,
    { method: "GET" }
  );

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return { success: true, data: res.data };
}

/**
 * Ejecuta la Fase 1 del protocolo: Pre-check diferencial rápido.
 * Compara las claves en base de datos para clasificar duplicadas, anuladas y nuevas.
 * Soporta tanto comprobantes recibidos como emitidos.
 *
 * @async
 * @param {string} apiUrl - URL base de la API.
 * @param {string} apiKey - API Key.
 * @param {Array<object>} rawInvoices - Lista de comprobantes extraídos del portal.
 * @param {string} [tipoSincronizacion="RECIBIDOS"] - "RECIBIDOS" o "EMITIDOS".
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function preCheckInvoices(
  apiUrl,
  apiKey,
  rawInvoices,
  tipoSincronizacion = "RECIBIDOS"
) {
  if (!Array.isArray(rawInvoices) || rawInvoices.length === 0) {
    return {
      success: true,
      data: {
        total_analizados: 0,
        duplicadas: [],
        por_sincronizar: [],
        anuladas_detectadas: [],
        resumen: {
          total: 0,
          duplicadas_count: 0,
          por_sincronizar_count: 0,
          anuladas_count: 0,
        },
      },
    };
  }

  const esEmitido = tipoSincronizacion === "EMITIDOS";

  // Mapear al DTO esperado por el backend
  const comprobantesDto = rawInvoices
    .filter((inv) => /^\d{49}$/.test(inv.claveAcceso || ""))
    .map((inv) => {
      // Extraer cod_doc desde las posiciones 9 y 10 de la clave de acceso
      const codDoc = inv.codDoc || inv.claveAcceso.substring(8, 10);
      const totalNum = parseSriAmount(inv.importeTotal);

      return {
        clave_acceso: inv.claveAcceso,
        cod_doc: codDoc,
        emisor_ruc: inv.ruc || "",
        emisor_nombre: inv.razonSocial || "",
        total: totalNum,
        fecha_emision: inv.fechaEmision || "",
        estado_portal: inv.estadoPortal || "AUTORIZADO",
        es_emitido: esEmitido,
      };
    });

  const res = await fetchEmiteApi(
    "/api/v1/facturas-recibidas/sincronizar/pre-check",
    apiUrl,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        comprobantes: comprobantesDto,
        tipo_sincronizacion: tipoSincronizacion,
      }),
    }
  );

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return { success: true, data: res.data };
}

/**
 * Ejecuta la Fase 2 del protocolo: Ingesta de un micro-lote (chunk de máx 5 claves).
 *
 * @async
 * @param {string} apiUrl - URL base de la API.
 * @param {string} apiKey - API Key.
 * @param {Array<string|object>} chunk - Lote de hasta 5 claves o comprobantes con XML.
 * @param {number} [ambiente=2] - Ambiente del SRI (1 pruebas, 2 producción).
 * @param {string} [tipoSincronizacion="RECIBIDOS"] - "RECIBIDOS" o "EMITIDOS".
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function ingestChunk(
  apiUrl,
  apiKey,
  chunk,
  ambiente = 2,
  tipoSincronizacion = "RECIBIDOS"
) {
  if (!Array.isArray(chunk) || chunk.length === 0) {
    return {
      success: true,
      data: {
        procesados: 0,
        guardados: [],
        fallidos: [],
        total_guardados: 0,
        total_fallidos: 0,
      },
    };
  }

  if (chunk.length > 5) return { success: false, error: "Máximo 5 comprobantes por lote" };
  const payload = {
    ambiente,
    tipo_sincronizacion: tipoSincronizacion,
  };
  if (typeof chunk[0] === "string") {
    payload.claves_acceso = chunk.slice(0, 5);
  } else if (typeof chunk[0] === "object") {
    payload.comprobantes = chunk.slice(0, 5);
    payload.claves_acceso = chunk.slice(0, 5).map((c) => c.clave_acceso);
  }

  const res = await fetchEmiteApi(
    "/api/v1/facturas-recibidas/sincronizar/ingestar-claves",
    apiUrl,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return { success: true, data: res.data };
}

/**
 * Notifica al backend de EMITE.ec las facturas detectadas como anuladas en el SRI.
 *
 * @async
 * @param {string} apiUrl - URL base de la API.
 * @param {string} apiKey - API Key.
 * @param {Array<string>} clavesAnuladas - Lista de claves anuladas.
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function updateVoidedInvoices(apiUrl, apiKey, clavesAnuladas, tipoSincronizacion = "RECIBIDOS") {
  if (!Array.isArray(clavesAnuladas) || clavesAnuladas.length === 0) {
    return { success: true, data: { total_actualizadas: 0 } };
  }

  const res = await fetchEmiteApi(
    "/api/v1/facturas-recibidas/sincronizar/actualizar-anuladas",
    apiUrl,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        claves_acceso: clavesAnuladas,
        tipo_sincronizacion: tipoSincronizacion,
        motivo: "Detectado como anulado en portal SRI vía extensión",
      }),
    }
  );

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return { success: true, data: res.data };
}
