// popup.js — Lógica principal del popup de SRI Pro XML (v3.3)

import { convertToCSV, downloadCSV } from "./excel_export.js";
import { generateFilename } from "./utils.js";
import { injectIcons } from "./icons.js";
import { testConnection } from "./emite_sync.js";

document.addEventListener("DOMContentLoaded", function () {
  // Inyectar íconos SVG en los botones
  injectIcons();

  // ─── Elementos del DOM ───────────────────────────────────────────────
  const scanBtn = document.getElementById("scanBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const exportBtn = document.getElementById("exportBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const syncEmiteBtn = document.getElementById("syncEmiteBtn");
  const actionButtons = document.getElementById("actionButtons");
  const listContainer = document.getElementById("listContainer");
  const facturasList = document.getElementById("facturasList");
  const progressContainer = document.getElementById("progressContainer");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const totalInvoicesEl = document.getElementById("totalInvoices");
  const totalAmountEl = document.getElementById("totalAmount");
  const toggleConfigBtn = document.getElementById("toggleConfigBtn");
  const configPanel = document.getElementById("configPanel");
  const folderInput = document.getElementById("folderInput");
  const saveConfigBtn = document.getElementById("saveConfigBtn");
  const configStatus = document.getElementById("configStatus");
  const debugLog = document.getElementById("debugLog");
  const instructionsCard = document.getElementById("instructionsCard");

  // Elementos de EMITE.ec
  const syncResultCard = document.getElementById("syncResultCard");
  const syncNewCount = document.getElementById("syncNewCount");
  const syncDupCount = document.getElementById("syncDupCount");
  const syncVoidCount = document.getElementById("syncVoidCount");
  const syncNcCount = document.getElementById("syncNcCount");
  const syncResultMsg = document.getElementById("syncResultMsg");
  const syncErrorDetail = document.getElementById("syncErrorDetail");

  const emiteApiUrlInput = document.getElementById("emiteApiUrl");
  const emiteApiKeyInput = document.getElementById("emiteApiKey");
  const saveEmiteBtn = document.getElementById("saveEmiteBtn");
  const testEmiteBtn = document.getElementById("testEmiteBtn");
  const emiteConnectionBadge = document.getElementById("emiteConnectionBadge");
  const emiteConfigStatus = document.getElementById("emiteConfigStatus");

  let currentInvoices = [];
  let currentOrigenConsulta = "DESCONOCIDO";

  /**
   * Oculta y resetea todos los datos previos mostrados en la interfaz.
   * Cumple con la regla de reseteo completo antes de un nuevo escaneo.
   */
  function resetPreviousData() {
    currentInvoices = [];
    currentOrigenConsulta = "DESCONOCIDO";
    totalInvoicesEl.textContent = "0";
    totalAmountEl.textContent = "$0.00";

    // Ocultar y vaciar lista de facturas
    listContainer.classList.add("hidden");
    facturasList.innerHTML = "";

    // Ocultar y resetear tarjeta de resultado de sincronización
    syncResultCard.classList.add("hidden");
    syncNewCount.textContent = "0";
    syncDupCount.textContent = "0";
    syncVoidCount.textContent = "0";
    syncNcCount.textContent = "0";
    syncResultMsg.textContent = "";
    if (syncErrorDetail) {
      syncErrorDetail.classList.add("hidden");
      syncErrorDetail.textContent = "";
    }

    // Ocultar botones de acción secundarios hasta nuevo escaneo exitoso
    actionButtons.classList.add("hidden");

    // Mostrar instrucciones si estaban ocultas
    if (instructionsCard) {
      instructionsCard.classList.remove("hidden");
    }

    // Ocultar contenedor de barra de progreso si no está en proceso activo
    progressContainer.classList.add("hidden");

    // Limpiar almacenamiento local para que no reaparezcan datos viejos al reabrir el popup
    chrome.storage.local.remove(["lastEmiteSyncResult", "emiteSyncState"]);
  }

  // ─── Escanear Facturas ───────────────────────────────────────────────

  scanBtn.addEventListener("click", async () => {
    resetPreviousData();
    updateStatus("Escaneando página actual...", 5);
    clearDebug();

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab) {
      updateStatus("Error: No se detectó pestaña activa", 0, true);
      return;
    }

    try {
      logDebug("v3.2: Intentando comunicacion via mensaje...");
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: "extractInvoices",
        });
        if (response) {
          logDebug("Respuesta recibida.");
          if (response.logs) response.logs.forEach((l) => logDebug(l));
          if (response.origenConsulta) {
            currentOrigenConsulta = response.origenConsulta;
            logDebug(`Origen detectado: ${currentOrigenConsulta}`);
          }

          if (response.error) {
            logDebug("Error: " + response.error);
            updateStatus(response.error, 0, true);
          }
          handleScanResult(response.invoices);
          return;
        }
      } catch (msgError) {
        logDebug("Mensajería falló: " + msgError.message);
        logDebug("Intentando inyección directa...");
      }

      // Fallback: Inyección directa en todos los frames
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractInvoicesFromPage,
      });

      let foundInvoices = [];
      for (const frameResult of injectionResults) {
        if (
          frameResult.result &&
          frameResult.result.invoices &&
          frameResult.result.invoices.length > 0
        ) {
          foundInvoices = foundInvoices.concat(frameResult.result.invoices);
          if (frameResult.result.origenConsulta && frameResult.result.origenConsulta !== "DESCONOCIDO") {
            currentOrigenConsulta = frameResult.result.origenConsulta;
          }
          if (frameResult.result.logs)
            frameResult.result.logs.forEach((l) => logDebug("[Inj] " + l));
        } else if (frameResult.result && frameResult.result.logs) {
          frameResult.result.logs.forEach((l) => logDebug("[Inj] " + l));
        }
      }

      logDebug(`Inyeccion completada. Encontradas: ${foundInvoices.length} (${currentOrigenConsulta})`);

      if (foundInvoices.length > 0) {
        // Eliminar duplicados por numero de factura
        const uniqueInvoices = Array.from(
          new Map(foundInvoices.map((item) => [item.numero, item])).values()
        );
        handleScanResult(uniqueInvoices);
      } else {
        updateStatus("No se encontraron facturas.", 0, true);
        logDebug("Sugerencia: Expande la tabla a 50 filas.");
      }
    } catch (error) {
      console.error("Error fatal:", error);
      updateStatus("Error crítico. Ver log abajo.", 0, true);
      logDebug("Error: " + error.message);
      debugLog.classList.remove("hidden");
    }
  });

  // ─── Procesamiento de Resultados ─────────────────────────────────────

  function handleScanResult(invoices) {
    if (invoices && invoices.length > 0) {
      currentInvoices = invoices;
      updateDashboard(currentInvoices);

      actionButtons.classList.remove("hidden");
      listContainer.classList.remove("hidden");
      progressContainer.classList.add("hidden");
      if (instructionsCard) instructionsCard.classList.add("hidden");

      renderList(currentInvoices);
    } else {
      updateStatus("No se encontraron facturas.", 0, true);
    }
  }

  // ─── Log de Depuración ───────────────────────────────────────────────

  function logDebug(msg) {
    debugLog.classList.remove("hidden");
    const line = document.createElement("div");
    line.textContent = `> ${msg}`;
    debugLog.appendChild(line);
    console.log(msg);
  }

  function clearDebug() {
    debugLog.innerHTML = "";
    debugLog.classList.add("hidden");
  }

  // ─── Funcion Inyectada v3.2 (misma logica robusta que content.js) ───
  // NOTA: Esta funcion se inyecta en la pagina via chrome.scripting.executeScript
  // y no puede importar modulos. Por eso la logica de extraccion esta duplicada.

  function extractInvoicesFromPage() {
    const logs = [];
    const log = (msg) => {
      console.log(msg);
      logs.push(msg);
    };

    try {
      // Detectar contexto emitidos vs recibidos (inline por inyeccion)
      let origenConsulta = "DESCONOCIDO";
      const urlLower = (window.location.href || "").toLowerCase();
      const titleLower = (document.title || "").toLowerCase();
      if (urlLower.includes("emitido") || urlLower.includes("emitid")) {
        origenConsulta = "EMITIDOS";
      } else if (urlLower.includes("recibido") || urlLower.includes("recibid")) {
        origenConsulta = "RECIBIDOS";
      } else if (titleLower.includes("emitido") || titleLower.includes("emitid")) {
        origenConsulta = "EMITIDOS";
      } else if (titleLower.includes("recibido") || titleLower.includes("recibid")) {
        origenConsulta = "RECIBIDOS";
      } else {
        const encabezados = document.querySelectorAll(
          "h1, h2, h3, .ui-panel-title, .ui-fieldset-legend, span.ui-outputlabel"
        );
        for (const el of encabezados) {
          const texto = (el.textContent || "").toLowerCase();
          if (texto.includes("emitido") || texto.includes("emitid")) {
            origenConsulta = "EMITIDOS";
            break;
          }
          if (texto.includes("recibido") || texto.includes("recibid")) {
            origenConsulta = "RECIBIDOS";
            break;
          }
        }
        if (origenConsulta === "DESCONOCIDO") {
          const breadcrumbs = document.querySelectorAll(
            ".ui-breadcrumb li, .ui-menuitem-text, .ui-menuitem-link"
          );
          for (const el of breadcrumbs) {
            const texto = (el.textContent || "").toLowerCase();
            if (texto.includes("emitido") || texto.includes("emitid")) {
              origenConsulta = "EMITIDOS";
              break;
            }
            if (texto.includes("recibido") || texto.includes("recibid")) {
              origenConsulta = "RECIBIDOS";
              break;
            }
          }
        }
        if (origenConsulta === "DESCONOCIDO") {
          const columnas = document.querySelectorAll("th, .ui-column-title");
          for (const col of columnas) {
            const texto = (col.textContent || "").toLowerCase();
            if (texto.includes("receptor") || texto.includes("comprador")) {
              origenConsulta = "EMITIDOS";
              break;
            }
            if (texto.includes("emisor") || texto.includes("proveedor")) {
              origenConsulta = "RECIBIDOS";
              break;
            }
          }
        }
      }
      log(`Inj: Contexto detectado: ${origenConsulta}`);

      const invoices = [];
      // Selector robusto para filas PrimeFaces
      let rows = document.querySelectorAll("tr[data-ri]");

      if (rows.length === 0) {
        log("Inj: tr[data-ri] no encontrados. Intentando genérico...");
        rows = document.querySelectorAll("table tbody tr");
        const filtered = [];
        rows.forEach((r) => {
          if (r.innerText && /\d{2}\/\d{2}\/\d{4}/.test(r.innerText))
            filtered.push(r);
        });
        rows = filtered;
      }

      log(`Inj: Filas encontradas: ${rows.length}`);

      if (rows.length === 0) {
        return {
          invoices: [],
          count: 0,
          logs: logs,
          error: "No se encontró tabla de facturas.",
        };
      }

      // Limpieza robusta de texto en celdas
      const clean = (el) => {
        if (!el) return "";
        let html = el.innerHTML || "";
        html = html.replace(/<br\s*\/?>/gi, " ");
        html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "");
        let txt = html.replace(/<[^>]*>/g, " ");
        return txt.replace(/\s+/g, " ").trim();
      };

      // Patrones de extracción
      const INVOICE_PATTERN = /(\d{3}-\d{3}-\d{9,})/;
      const RUC_PATTERN = /\b(\d{13})\b/;
      const DATE_PATTERN = /(\d{2}\/\d{2}\/\d{4})/;
      const MONEY_PATTERN = /^\d{1,3}([.,]\d{3})*[.,]\d{2}$/;

      rows.forEach((row, index) => {
        try {
          const cells = row.querySelectorAll("td");
          if (cells.length < 3) return;

          const cellTexts = Array.from(cells).map((c) => clean(c));

          if (index === 0)
            log(`Inj Fila 0: ${cellTexts.slice(0, 3).join("|")}`);

          let numero = "SIN_NUMERO";
          let ruc = "SIN_RUC";
          let razonSocial = "SIN_RAZON";
          let fechaEmision = "SIN_FECHA";
          let fechaAutorizacion = "";
          let valorSinImpuestos = "0.00";
          let iva = "0.00";
          let importeTotal = "0.00";

          // 1. Número de factura
          for (let txt of cellTexts) {
            const m = txt.match(INVOICE_PATTERN);
            if (m) {
              numero = m[0];
              break;
            }
          }

          // 2. RUC y Razón Social
          for (let txt of cellTexts) {
            const m = txt.match(RUC_PATTERN);
            if (m) {
              ruc = m[0];
              let remainder = txt.replace(ruc, "").trim();
              remainder = remainder.replace(/^[\s-.,]+/, "");
              if (remainder.length > 2) razonSocial = remainder;
              break;
            }
          }

          // 3. Fechas
          const foundDates = [];
          for (let txt of cellTexts) {
            const m = txt.match(DATE_PATTERN);
            if (m) foundDates.push(m[0]);
          }
          if (foundDates.length > 0) fechaEmision = foundDates[0];
          fechaAutorizacion = foundDates.length > 1 ? foundDates[1] : "";

          // 4. Valores monetarios (desde el final de la fila)
          const moneyValues = [];
          for (let i = cellTexts.length - 1; i >= 0; i--) {
            let val = cellTexts[i].replace("$", "").trim();
            if (MONEY_PATTERN.test(val)) moneyValues.unshift(val);
            if (moneyValues.length >= 3) break;
          }
          if (moneyValues.length >= 1)
            importeTotal = moneyValues[moneyValues.length - 1];
          if (moneyValues.length >= 2)
            iva = moneyValues[moneyValues.length - 2];
          if (moneyValues.length >= 3)
            valorSinImpuestos = moneyValues[moneyValues.length - 3];

          let tipoSerie = "";
          let claveAcceso = "";

          // Búsqueda de clave de acceso (49 dígitos)
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

          let codDoc = "01";
          if (claveAcceso && claveAcceso.length === 49) {
            codDoc = claveAcceso.substring(8, 10);
          }

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

          // Enlace XML (búsqueda prioritaria → secundaria → terciaria)
          let xmlLinkId = null;
          let anchor = row.querySelector('a[id*="lnkXml"]');
          if (!anchor) {
            const img = row.querySelector('img[src*="xml.gif"]');
            if (img) anchor = img.closest("a");
          }
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
            if (!anchor.id)
              anchor.id = "sri_gen_" + Math.random().toString(36).substr(2);
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
            });
          }
        } catch (e) {
          // Ignorar fila con error de parseo
        }
      });

      return { invoices, count: invoices.length, origenConsulta, logs: logs };
    } catch (e) {
      return { error: e.message, logs: [e.message] };
    }
  }

  // ─── Descargar XMLs de la Página Actual ──────────────────────────────

  downloadBtn.addEventListener("click", () => {
    if (currentInvoices.length === 0) return;
    processDownloads(currentInvoices);
  });

  // ─── Exportar a CSV ──────────────────────────────────────────────────

  exportBtn.addEventListener("click", () => {
    if (currentInvoices.length === 0) return;
    const csv = convertToCSV(currentInvoices);
    downloadCSV(
      csv,
      `reporte_sri_${new Date().toISOString().slice(0, 10)}.csv`
    );
  });

  // ─── Descarga Masiva (Todas las Páginas) ─────────────────────────────

  downloadAllBtn.addEventListener("click", () => {
    startBatchDownload();
  });

  // ─── Funciones de UI ─────────────────────────────────────────────────

  /**
   * Escapa caracteres HTML para prevenir inyección XSS
   * cuando se inserta texto dinámico vía innerHTML.
   */
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Actualiza el panel de estadísticas con los totales calculados.
   */
  function updateDashboard(invoices) {
    totalInvoicesEl.textContent = invoices.length;
    const total = invoices.reduce((sum, inv) => {
      const val = parseFloat(inv.importeTotal.replace(",", ".") || 0);
      return sum + val;
    }, 0);
    totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  /**
   * Renderiza la lista visual de facturas escaneadas.
   * Usa escapeHtml para prevenir XSS en datos provenientes del DOM del SRI.
   */
  function renderList(invoices) {
    facturasList.innerHTML = invoices
      .map(
        (inv) => `
      <div class="invoice-item">
        <div class="invoice-info">
          <span class="invoice-name">${escapeHtml(inv.razonSocial)}</span>
          <span class="invoice-number">${escapeHtml(inv.numero)}</span>
        </div>
        <div class="invoice-amount">$${escapeHtml(inv.importeTotal)}</div>
      </div>
    `
      )
      .join("");
  }

  /**
   * Actualiza la barra de progreso y su texto.
   * Usa classList para alternar estados visuales (error/éxito)
   * en lugar de manipulación directa de .style.
   */
  function updateStatus(text, percent, isError = false) {
    progressContainer.classList.remove("hidden");
    progressText.textContent = text;

    // Alternar clases de estado visual
    progressText.classList.toggle("progress-text--error", isError);
    progressBar.classList.toggle("progress-bar--error", isError);

    // Ancho dinámico de la barra via CSS custom property
    progressBar.style.setProperty('--progress-width', `${percent}%`);
  }

  // ─── Configuración ───────────────────────────────────────────────────

  chrome.storage.local.get(["downloadFolder"], (result) => {
    if (result.downloadFolder) {
      folderInput.value = result.downloadFolder;
    }
  });

  toggleConfigBtn.addEventListener("click", () => {
    configPanel.classList.toggle("hidden");
  });

  saveConfigBtn.addEventListener("click", () => {
    const folder = folderInput.value.trim().replace(/[\\:*?"<>|]/g, "");
    chrome.storage.local.set({ downloadFolder: folder }, () => {
      configStatus.textContent = "Guardado correctamente";
      configStatus.classList.add("config-status--success");
      setTimeout(() => {
        configStatus.textContent = "";
        configStatus.classList.remove("config-status--success");
      }, 2000);
    });
  });

  // ─── Configuración EMITE.ec ──────────────────────────────────────────

  chrome.storage.local.get(
    ["emiteApiUrl", "emiteApiKey", "lastEmiteSyncResult", "emiteSyncState"],
    (result) => {
      if (result.emiteApiUrl) {
        emiteApiUrlInput.value = result.emiteApiUrl;
      } else {
        emiteApiUrlInput.value = "https://api.emite.ec";
      }

      if (result.emiteApiKey) {
        emiteApiKeyInput.value = result.emiteApiKey;
        emiteConnectionBadge.textContent = "Configurado";
        emiteConnectionBadge.className = "connection-badge badge--connected";
      }

      if (result.lastEmiteSyncResult) {
        renderSyncResult(result.lastEmiteSyncResult);
      }

      if (result.emiteSyncState && result.emiteSyncState.status === "IN_PROGRESS") {
        updateStatus(result.emiteSyncState.step, result.emiteSyncState.progress);
      }
    }
  );

  saveEmiteBtn.addEventListener("click", () => {
    const url = emiteApiUrlInput.value.trim() || "https://api.emite.ec";
    const key = emiteApiKeyInput.value.trim();
    chrome.storage.local.set({ emiteApiUrl: url, emiteApiKey: key }, () => {
      emiteConfigStatus.textContent = "Configuración guardada";
      emiteConfigStatus.classList.add("config-status--success");
      if (key) {
        emiteConnectionBadge.textContent = "Configurado";
        emiteConnectionBadge.className = "connection-badge badge--connected";
      }
      setTimeout(() => {
        emiteConfigStatus.textContent = "";
        emiteConfigStatus.classList.remove("config-status--success");
      }, 2000);
    });
  });

  testEmiteBtn.addEventListener("click", async () => {
    const url = emiteApiUrlInput.value.trim() || "https://api.emite.ec";
    const key = emiteApiKeyInput.value.trim();
    if (!key) {
      emiteConnectionBadge.textContent = "Sin API Key";
      emiteConnectionBadge.className = "connection-badge badge--disconnected";
      emiteConfigStatus.textContent = "Ingresa tu API Key primero";
      return;
    }

    emiteConnectionBadge.textContent = "Probando...";
    emiteConnectionBadge.className = "connection-badge badge--testing";

    const res = await testConnection(url, key);
    if (res.success && res.data) {
      const companyName = res.data.razon_social || res.data.ruc || "Conectado";
      emiteConnectionBadge.textContent = companyName;
      emiteConnectionBadge.className = "connection-badge badge--connected";
      emiteConfigStatus.textContent = `Conexión exitosa con ${companyName}`;
      emiteConfigStatus.classList.add("config-status--success");
      chrome.storage.local.set({
        emiteApiUrl: url,
        emiteApiKey: key,
        tenantRuc: res.data.ruc || "",
        tenantRazonSocial: res.data.razon_social || "",
      });
    } else {
      emiteConnectionBadge.textContent = "Error";
      emiteConnectionBadge.className = "connection-badge badge--disconnected";
      emiteConfigStatus.textContent = res.error || "Fallo de conexión";
    }
    setTimeout(() => {
      emiteConfigStatus.textContent = "";
      emiteConfigStatus.classList.remove("config-status--success");
    }, 4000);
  });

  // ─── Sincronización con EMITE.ec ─────────────────────────────────────

  syncEmiteBtn.addEventListener("click", async () => {
    const storage = await chrome.storage.local.get(["emiteApiKey"]);
    if (!storage.emiteApiKey) {
      configPanel.classList.remove("hidden");
      emiteApiKeyInput.focus();
      updateStatus("Ingresa tu API Key de EMITE.ec en Configuración", 0, true);
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      updateStatus("Error: No se detectó pestaña activa", 0, true);
      return;
    }

    // Verificar que haya comprobantes escaneados previamente
    if (!currentInvoices || currentInvoices.length === 0) {
      updateStatus("Debes presionar 'Escanear Página Actual' primero.", 0, true);
      return;
    }

    // Determinar etiqueta segun contexto
    const esEmitidos = currentOrigenConsulta === "EMITIDOS";
    const etiquetaOrigen = esEmitidos ? "emitidos" : "recibidos";

    // Inicializar visualmente la tarjeta de sincronizacion en tiempo real de inmediato
    syncResultCard.classList.remove("hidden");
    syncNewCount.textContent = "0";
    syncDupCount.textContent = "0";
    syncVoidCount.textContent = "0";
    syncNcCount.textContent = "0";
    syncResultMsg.textContent = `Analizadas: ${currentInvoices.length} (${etiquetaOrigen}). Iniciando analisis en tiempo real...`;
    if (syncErrorDetail) {
      syncErrorDetail.classList.add("hidden");
      syncErrorDetail.textContent = "";
    }

    updateStatus(`Iniciando sincronizacion de ${etiquetaOrigen} con EMITE.ec...`, 5);
    chrome.runtime.sendMessage({
      action: "startEmiteSync",
      tabId: tab.id,
      invoices: currentInvoices,
      origenConsulta: currentOrigenConsulta,
    });
  });

  function renderSyncResult(result) {
    if (!result) return;
    syncResultCard.classList.remove("hidden");
    syncNewCount.textContent = result.totalSincronizadas ?? 0;
    syncDupCount.textContent = result.totalDuplicadas ?? 0;
    syncVoidCount.textContent = result.totalAnuladas ?? 0;
    syncNcCount.textContent = result.notasCredito ?? 0;

    const tipoTxt =
      result.tipoSincronizacion === "EMITIDOS"
        ? " (Emitidas)"
        : result.tipoSincronizacion === "RECIBIDOS"
        ? " (Recibidas)"
        : "";
    let msg = `Analizadas: ${result.totalAnalizados ?? 0}${tipoTxt}. Sincronizadas: ${result.totalSincronizadas ?? 0}. `;
    if (result.totalFallidas > 0) {
      msg += `Fallidas: ${result.totalFallidas}. `;
    }
    if (result.enProgreso && result.totalLotes > 0) {
      msg += `(Lote ${result.loteActual ?? 1} de ${result.totalLotes} en proceso...)`;
    }
    syncResultMsg.textContent = msg;

    if (
      result.totalFallidas > 0 &&
      Array.isArray(result.fallidosDetalle) &&
      result.fallidosDetalle.length > 0
    ) {
      const motivos = [
        ...new Set(
          result.fallidosDetalle
            .map((f) => f.error)
            .filter((err) => Boolean(err))
        ),
      ];
      const detalleTexto =
        motivos.length > 0
          ? `Causa del fallo: ${motivos.slice(0, 2).join(" | ")}`
          : "Causa no especificada por el servidor.";
      syncErrorDetail.textContent = detalleTexto;
      syncErrorDetail.classList.remove("hidden");
    } else {
      syncErrorDetail.classList.add("hidden");
      syncErrorDetail.textContent = "";
    }
  }

  // Escuchar cambios de estado en chrome.storage para reactividad en tiempo real
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.emiteSyncState) {
        const state = changes.emiteSyncState.newValue;
        if (state) {
          if (state.status === "IN_PROGRESS") {
            updateStatus(state.step, state.progress);
          } else if (state.status === "SUCCESS") {
            updateStatus(state.step, 100);
            setTimeout(() => {
              progressContainer.classList.add("hidden");
            }, 3000);
          } else if (state.status === "ERROR") {
            updateStatus(state.error || state.step, 0, true);
          }
        }
      }
      if (changes.lastEmiteSyncResult) {
        renderSyncResult(changes.lastEmiteSyncResult.newValue);
      }
    }
  });

  // ─── Proceso de Descargas ────────────────────────────────────────────

  async function processDownloads(invoices) {
    updateStatus("Iniciando descargas...", 0);

    let completed = 0;
    const total = invoices.length;
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const { downloadFolder } = await chrome.storage.local.get([
      "downloadFolder",
    ]);

    for (const inv of invoices) {
      try {
        let filename = generateFilename(inv);
        if (downloadFolder) {
          filename = `${downloadFolder}/${filename}`;
        }

        await chrome.tabs.sendMessage(tab.id, {
          action: "downloadSingleXML",
          linkId: inv.xmlLinkId,
          filename: filename,
        });

        completed++;
        updateStatus(
          `Descargando ${completed}/${total}`,
          (completed / total) * 100
        );
      } catch (e) {
        console.error("Error descargando", inv, e);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    updateStatus("Descarga completada", 100);
    setTimeout(() => {
      progressContainer.classList.add("hidden");
    }, 3000);
  }

  function startBatchDownload() {
    updateStatus("Iniciando descarga masiva...", 0);

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "downloadAllPages",
      });
    });
  }

  // ─── Listener de Progreso ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "updateProgress") {
      const percent = (request.current / request.total) * 100;
      updateStatus(`Procesando: ${request.current}/${request.total}`, percent);
    }
  });
});
