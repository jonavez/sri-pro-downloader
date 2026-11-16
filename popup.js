// popup.js — Lógica principal del popup de SRI Pro XML (v3.3)

import { convertToCSV, downloadCSV } from "./excel_export.js";
import { parseSriAmount } from "./utils.js";
import { injectIcons } from "./icons.js";
import { normalizeApiUrl, testConnection } from "./emite_sync.js";

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("clearDataBtn").addEventListener("click", async () => {
    const { emiteSyncState } = await chrome.storage.local.get("emiteSyncState");
    if (emiteSyncState?.status === "IN_PROGRESS") { updateStatus("Espera a que termine la sincronización para borrar sus datos.", 0, true); return; }
    await chrome.storage.local.clear();
    location.reload();
  });
  // Inyectar íconos SVG en los botones
  injectIcons();

  // ─── Elementos del DOM ───────────────────────────────────────────────
  const scanBtn = document.getElementById("scanBtn");
  const scanAllBtn = document.getElementById("scanAllBtn");
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

  let scannedTabId = null;
  let scannedFrameId = 0;

  async function scan(allPages) {
    const { emiteSyncState } = await chrome.storage.local.get("emiteSyncState");
    if (emiteSyncState?.status === "IN_PROGRESS") {
      updateStatus("Espera a que termine la sincronización antes de escanear.", 0, true);
      return;
    }
    resetPreviousData();
    clearDebug();
    scanBtn.disabled = scanAllBtn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.startsWith("https://srienlinea.sri.gob.ec/")) throw new Error("Abre tu consulta en el portal oficial del SRI.");
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
      const probes = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => globalThis.__sriProApi?.extract(),
      });
      const frame = probes.find((probe) => probe.result?.invoices?.length);
      if (!frame) throw new Error("No se encontraron comprobantes. Realiza una consulta en el SRI.");
      scannedTabId = tab.id;
      scannedFrameId = frame.frameId;
      updateStatus(allPages ? "Escaneando todas las páginas..." : "Leyendo comprobantes...", 10);
      const response = allPages ? await chrome.tabs.sendMessage(tab.id, { action: "scanAllPages" }, { frameId: scannedFrameId }) : frame.result;
      if (response?.error) throw new Error(response.error);
      currentOrigenConsulta = response.origenConsulta || "DESCONOCIDO";
      handleScanResult(response.invoices);
    } catch (error) {
      updateStatus(error.message, 0, true);
    } finally {
      scanBtn.disabled = scanAllBtn.disabled = false;
    }
  }
  scanBtn.addEventListener("click", () => scan(false));
  scanAllBtn.addEventListener("click", () => scan(true));
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.tab?.id !== scannedTabId || sender.frameId !== scannedFrameId) return;
    if (message.action === "scanAllProgress") updateStatus(`Página ${message.page}: ${message.totalAccumulated} comprobantes`, Math.min(95, message.page * 2));
    if (message.action === "downloadError") updateStatus(message.error, 0, true);
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

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
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
      const val = parseSriAmount(inv.importeTotal);
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
    try { normalizeApiUrl(url); } catch (error) { emiteConfigStatus.textContent = error.message; return; }
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
    if (!tab || tab.id !== scannedTabId) {
      updateStatus("Vuelve a la pestaña del SRI que escaneaste.", 0, true);
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
    chrome.runtime.sendMessage(
      {
        action: "startEmiteSync",
        tabId: tab.id,
        frameId: scannedFrameId,
        invoices: currentInvoices,
        origenConsulta: currentOrigenConsulta,
      },
      (response) => {
        if (response?.started === false) updateStatus(response.error, 0, true);
        if (chrome.runtime.lastError) {
          console.error(
            "[SRI Pro] Error comunicando con background:",
            chrome.runtime.lastError.message
          );
          updateStatus(
            `Error en el servicio de fondo: ${chrome.runtime.lastError.message}. Recarga la extensión en chrome://extensions`,
            0,
            true
          );
        }
      }
    );
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
          } else if (["SUCCESS", "PARTIAL"].includes(state.status)) {
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== scannedTabId) { updateStatus("Vuelve a la pestaña escaneada", 0, true); return; }
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { action: "downloadInvoices", invoices }, { frameId: scannedFrameId });
      if (!result?.started) throw new Error(result?.error || "No se inició la descarga");
      updateStatus("Descarga iniciada. Puedes cerrar el popup; mantén abierta la consulta del SRI.", 5);
    } catch (error) { updateStatus(error.message, 0, true); }
  }

  function startBatchDownload() {
    updateStatus("Iniciando descarga masiva...", 0);

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]?.id !== scannedTabId) { updateStatus("Vuelve a la pestaña escaneada", 0, true); return; }
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "downloadAllPages",
      }, { frameId: scannedFrameId });
    });
  }

  // ─── Listener de Progreso ────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((request, sender) => {
    if (sender.tab?.id !== scannedTabId || sender.frameId !== scannedFrameId) return;
    if (request.action === "updateProgress") {
      const percent = Number.isFinite(request.total) && request.total > 0 ? (request.current / request.total) * 100 : 50;
      updateStatus(`Procesando: ${request.current}/${request.total}`, percent);
    }
  });
});
