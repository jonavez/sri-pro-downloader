/**
 * @fileoverview Cliente de sincronización para la API de EMITE.ec.
 *
 * Encapsula la comunicación segura entre la extensión SRI Pro Downloader
 * y el backend de EMITE.ec (facturador-ec/api), implementando el protocolo
 * diferencial de dos fases con micro-lotes (Chunked Differential Sync).
 *
 * Normas aplicadas:
 * - ISO/IEC 27001 (Seguridad de la información y menor privilegio)
 * - ISO/IEC 25010 (Mantenibilidad y tolerancia a fallos)
 *
 * @version 1.0.0
 * @module emite_sync
 */

const DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Normaliza la URL base de la API eliminando barras inclinadas al final.
 *
 * @param {string} url - URL base configurada.
 * @returns {string} URL normalizada sin barra final.
 */
function normalizeApiUrl(url) {
  if (!url || typeof url !== "string") return "https://api.emite.ec";
  let clean = url.trim();
  while (clean.endsWith("/")) {
    clean = clean.slice(0, -1);
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
  const baseUrl = normalizeApiUrl(apiUrl);
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
    });

    clearTimeout(timer);

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
 *
 * @async
 * @param {string} apiUrl - URL base de la API.
 * @param {string} apiKey - API Key.
 * @param {Array<object>} rawInvoices - Lista de comprobantes extraídos del portal.
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function preCheckInvoices(apiUrl, apiKey, rawInvoices) {
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

  // Mapear al DTO esperado por el backend
  const comprobantesDto = rawInvoices
    .filter((inv) => inv.claveAcceso && inv.claveAcceso.length === 49)
    .map((inv) => {
      // Extraer cod_doc desde las posiciones 9 y 10 de la clave de acceso
      const codDoc = inv.codDoc || inv.claveAcceso.substring(8, 10);
      const totalNum = parseFloat(
        (inv.importeTotal || "0").replace("$", "").replace(",", ".")
      ) || 0;

      return {
        clave_acceso: inv.claveAcceso,
        cod_doc: codDoc,
        emisor_ruc: inv.ruc || "",
        emisor_nombre: inv.razonSocial || "",
        total: totalNum,
        fecha_emision: inv.fechaEmision || "",
        estado_portal: inv.estadoPortal || "AUTORIZADO",
      };
    });

  const res = await fetchEmiteApi(
    "/api/v1/facturas-recibidas/sincronizar/pre-check",
    apiUrl,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({ comprobantes: comprobantesDto }),
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
 * @param {Array<string>} clavesChunk - Lote de hasta 5 claves de acceso.
 * @param {number} [ambiente=2] - Ambiente del SRI (1 pruebas, 2 producción).
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
export async function ingestChunk(apiUrl, apiKey, chunk, ambiente = 2) {
  if (!Array.isArray(chunk) || chunk.length === 0) {
    return {
      success: true,
      data: { procesados: 0, guardados: [], fallidos: [], total_guardados: 0, total_fallidos: 0 },
    };
  }

  const payload = { ambiente };
  if (typeof chunk[0] === "string") {
    payload.claves_acceso = chunk.slice(0, 5);
  } else if (typeof chunk[0] === "object") {
    payload.comprobantes = chunk.slice(0, 5);
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
export async function updateVoidedInvoices(apiUrl, apiKey, clavesAnuladas) {
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
        motivo: "Detectado como anulado en portal SRI vía extensión",
      }),
    }
  );

  if (!res.ok) {
    return { success: false, error: res.error };
  }

  return { success: true, data: res.data };
}
