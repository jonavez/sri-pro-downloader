import { convertToCSV, downloadCSV } from "./excel_export.js";
import { generateFilename } from "./utils.js";

document.addEventListener("DOMContentLoaded", function () {
  // Elementos UI
  const scanBtn = document.getElementById("scanBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const exportBtn = document.getElementById("exportBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const actionButtons = document.getElementById("actionButtons");
  const listContainer = document.getElementById("listContainer");
  const facturasList = document.getElementById("facturasList");
  const progressContainer = document.getElementById("progressContainer");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");

  // Stats
  const totalInvoicesEl = document.getElementById("totalInvoices");
  const totalAmountEl = document.getElementById("totalAmount");

  let currentInvoices = [];

  // 1. Escanear
  scanBtn.addEventListener("click", async () => {
    updateStatus("Escaneando...", 0);
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
      logDebug("v2.4: Intentando comunicación vía mensaje...");
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: "extractInvoices",
        });
        if (response) {
          logDebug("Respuesta recibida.");
          if (response.logs) response.logs.forEach((l) => logDebug(l));

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

      // Fallback: Inyección directa
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
          if (frameResult.result.logs)
            frameResult.result.logs.forEach((l) => logDebug("[Inj] " + l));
        } else if (frameResult.result && frameResult.result.logs) {
          frameResult.result.logs.forEach((l) => logDebug("[Inj] " + l));
        }
      }

      logDebug(`Inyección completada. Encontradas: ${foundInvoices.length}`);

      if (foundInvoices.length > 0) {
        // Eliminar duplicados
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
      document.getElementById("debugLog").style.display = "block";
    }
  });

  function handleScanResult(invoices) {
    if (invoices && invoices.length > 0) {
      currentInvoices = invoices;
      updateDashboard(currentInvoices);

      actionButtons.style.display = "block";
      listContainer.style.display = "block";
      progressContainer.style.display = "none";

      renderList(currentInvoices);
    } else {
      updateStatus("No se encontraron facturas.", 0, true);
    }
  }

  function logDebug(msg) {
    const debugEl = document.getElementById("debugLog");
    debugEl.style.display = "block"; // Asegurar que sea visible si hay logs
    const line = document.createElement("div");
    line.textContent = `> ${msg}`;
    debugEl.appendChild(line);
    console.log(msg);
  }

  function clearDebug() {
    const debugEl = document.getElementById("debugLog");
    debugEl.innerHTML = "";
    debugEl.style.display = "none";
  }

  // Función inyectada v2.4 (Misma lógica robusta que content.js)
  function extractInvoicesFromPage() {
    const logs = [];
    const log = (msg) => {
      console.log(msg);
      logs.push(msg);
    };

    try {
      const invoices = [];
      // Selector robusto
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
          error: `No se encontró tabla de facturas.`,
        };
      }

      // Helper limpieza robusta
      const clean = (el) => {
        if (!el) return "";
        let html = el.innerHTML || "";
        html = html.replace(/<br\s*\/?>/gi, " ");
        html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "");
        let txt = html.replace(/<[^>]*>/g, " ");
        return txt.replace(/\s+/g, " ").trim();
      };

      rows.forEach((row, index) => {
        try {
          const cells = row.querySelectorAll("td");
          if (cells.length < 3) return;

          const cellTexts = Array.from(cells).map((c) => clean(c));

          if (index === 0) log(`Inj Row 0: ${cellTexts.slice(0, 3).join("|")}`);

          const invoicePattern = /(\d{3}-\d{3}-\d{9,})/;
          const rucPattern = /\b(\d{13})\b/;
          const datePattern = /(\d{2}\/\d{2}\/\d{4})/;
          const moneyPattern = /^\d{1,3}([.,]\d{3})*[.,]\d{2}$/;

          let numero = "SIN_NUMERO";
          let ruc = "SIN_RUC";
          let razonSocial = "SIN_RAZON";
          let fechaEmision = "SIN_FECHA";
          let fechaAutorizacion = "";

          let valorSinImpuestos = "0.00";
          let iva = "0.00";
          let importeTotal = "0.00";

          // 1. Factura
          for (let txt of cellTexts) {
            const m = txt.match(invoicePattern);
            if (m) {
              numero = m[0];
              break;
            }
          }

          // 2. RUC
          for (let txt of cellTexts) {
            const m = txt.match(rucPattern);
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
            const m = txt.match(datePattern);
            if (m) foundDates.push(m[0]);
          }
          if (foundDates.length > 0) fechaEmision = foundDates[0];
          fechaAutorizacion = foundDates.length > 1 ? foundDates[1] : "";

          // 4. Dinero
          const moneyValues = [];
          for (let i = cellTexts.length - 1; i >= 0; i--) {
            let val = cellTexts[i].replace("$", "").trim();
            if (moneyPattern.test(val)) moneyValues.unshift(val);
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

            invoices.push({
              numero,
              ruc,
              razonSocial,
              tipoSerie,
              claveAcceso,
              fechaAutorizacion,
              fechaEmision,
              valorSinImpuestos,
              iva,
              importeTotal,
              xmlLinkId,
            });
          }
        } catch (e) {
          // ignore row
        }
      });

      return { invoices, count: invoices.length, logs: logs };
    } catch (e) {
      return { error: e.message, logs: [e.message] };
    }
  }

  // 2. Descargar XMLs
  downloadBtn.addEventListener("click", () => {
    if (currentInvoices.length === 0) return;
    processDownloads(currentInvoices);
  });

  // 3. Exportar Excel
  exportBtn.addEventListener("click", () => {
    if (currentInvoices.length === 0) return;
    const csv = convertToCSV(currentInvoices);
    downloadCSV(
      csv,
      `reporte_sri_${new Date().toISOString().slice(0, 10)}.csv`
    );
  });

  // 4. Descargar Todo
  downloadAllBtn.addEventListener("click", () => {
    startBatchDownload();
  });

  // Funciones Helper
  function updateDashboard(invoices) {
    totalInvoicesEl.textContent = invoices.length;
    const total = invoices.reduce((sum, inv) => {
      const val = parseFloat(inv.importeTotal.replace(",", ".") || 0);
      return sum + val;
    }, 0);
    totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  function renderList(invoices) {
    facturasList.innerHTML = invoices
      .map(
        (inv) => `
      <div class="invoice-item">
        <div class="invoice-info">
          <span style="font-weight:600; font-size:0.8rem;">${inv.razonSocial}</span>
          <span style="color:#64748b; font-size:0.75rem;">${inv.numero}</span>
        </div>
        <div class="invoice-amount">$${inv.importeTotal}</div>
      </div>
    `
      )
      .join("");
  }

  function updateStatus(text, percent, isError = false) {
    progressContainer.style.display = "block";
    progressText.textContent = text;
    progressText.style.color = isError ? "#ef4444" : "#64748b";
    progressBar.style.width = `${percent}%`;
    progressBar.style.backgroundColor = isError ? "#ef4444" : "#10b981";
  }

  // Configuración
  const toggleConfigBtn = document.getElementById("toggleConfigBtn");
  const configPanel = document.getElementById("configPanel");
  const folderInput = document.getElementById("folderInput");
  const saveConfigBtn = document.getElementById("saveConfigBtn");
  const configStatus = document.getElementById("configStatus");

  chrome.storage.local.get(["downloadFolder"], (result) => {
    if (result.downloadFolder) {
      folderInput.value = result.downloadFolder;
    }
  });

  toggleConfigBtn.addEventListener("click", () => {
    configPanel.style.display =
      configPanel.style.display === "none" ? "block" : "none";
  });

  saveConfigBtn.addEventListener("click", () => {
    const folder = folderInput.value.trim().replace(/[\\:*?"<>|]/g, ""); // Limpiar caracteres inválidos
    chrome.storage.local.set({ downloadFolder: folder }, () => {
      configStatus.textContent = "Guardado correctamente ✅";
      configStatus.style.color = "#10b981";
      setTimeout(() => (configStatus.textContent = ""), 2000);
    });
  });

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

    updateStatus("¡Descarga completada!", 100);
    setTimeout(() => {
      progressContainer.style.display = "none";
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

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "updateProgress") {
      const percent = (request.current / request.total) * 100;
      updateStatus(`Procesando: ${request.current}/${request.total}`, percent);
    }
  });
});
