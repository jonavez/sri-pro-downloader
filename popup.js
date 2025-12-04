import { convertToCSV, downloadCSV } from './excel_export.js';
import { generateFilename } from './utils.js';

document.addEventListener('DOMContentLoaded', function() {
  // Elementos UI
  const scanBtn = document.getElementById('scanBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const exportBtn = document.getElementById('exportBtn');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const actionButtons = document.getElementById('actionButtons');
  const listContainer = document.getElementById('listContainer');
  const facturasList = document.getElementById('facturasList');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  
  // Stats
  const totalInvoicesEl = document.getElementById('totalInvoices');
  const totalAmountEl = document.getElementById('totalAmount');

  let currentInvoices = [];

  // 1. Escanear
  scanBtn.addEventListener('click', async () => {
    updateStatus('Escaneando...', 0);
    clearDebug();
    
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    
    if (!tab) {
      updateStatus('Error: No se detectó pestaña activa', 0, true);
      return;
    }

    // Estrategia Híbrida:
    // 1. Intentar mensajería normal (content script ya cargado)
    // 2. Si falla, inyectar script manualmente
    
    try {
      logDebug('Intentando comunicación vía mensaje...');
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {action: 'extractInvoices'});
        if (response) {
          logDebug('Respuesta recibida por mensaje.');
          handleScanResult(response.invoices);
          return;
        }
      } catch (msgError) {
        logDebug('Mensajería falló: ' + msgError.message);
        logDebug('Intentando inyección directa...');
      }

      // Fallback: Inyección directa
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractInvoicesFromPage
      });

      let foundInvoices = [];
      for (const frameResult of injectionResults) {
        if (frameResult.result && frameResult.result.invoices && frameResult.result.invoices.length > 0) {
          foundInvoices = foundInvoices.concat(frameResult.result.invoices);
        }
      }

      logDebug(`Inyección completada. Encontradas: ${foundInvoices.length}`);
      
      if (foundInvoices.length > 0) {
        // Eliminar duplicados
        const uniqueInvoices = Array.from(new Map(foundInvoices.map(item => [item.numero, item])).values());
        handleScanResult(uniqueInvoices);
      } else {
        updateStatus('No se encontraron facturas.', 0, true);
        logDebug('Verifica que la tabla esté visible en la pantalla.');
      }

    } catch (error) {
      console.error('Error fatal:', error);
      updateStatus('Error crítico. Ver log abajo.', 0, true);
      logDebug('Error: ' + error.message);
      document.getElementById('debugLog').style.display = 'block';
    }
  });

  function handleScanResult(invoices) {
    if (invoices && invoices.length > 0) {
      currentInvoices = invoices;
      updateDashboard(currentInvoices);
      
      actionButtons.style.display = 'block';
      listContainer.style.display = 'block';
      progressContainer.style.display = 'none';
      
      renderList(currentInvoices);
    } else {
      updateStatus('No se encontraron facturas.', 0, true);
    }
  }

  function logDebug(msg) {
    const debugEl = document.getElementById('debugLog');
    const line = document.createElement('div');
    line.textContent = `> ${msg}`;
    debugEl.appendChild(line);
    console.log(msg);
  }

  function clearDebug() {
    const debugEl = document.getElementById('debugLog');
    debugEl.innerHTML = '';
    debugEl.style.display = 'none'; // Ocultar si estaba visible
  }

  // Función inyectada (usando textContent para mayor compatibilidad)
  function extractInvoicesFromPage() {
    try {
      const invoices = [];
      let rows = document.querySelectorAll('table[id*="tablaCompRecibidos"] tbody tr[data-ri]');
      
      if (rows.length === 0) {
        rows = document.querySelectorAll('tbody tr[data-ri]');
      }

      if (rows.length === 0) {
        return { invoices: [], count: 0 };
      }

      rows.forEach((row, index) => {
        try {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 8) {
            // Usar textContent en lugar de innerText para evitar problemas con estilos ocultos
            const getText = (idx) => cells[idx] ? cells[idx].textContent.trim() : '';
            
            const numero = getText(0);
            const rucRaw = getText(1);
            const parts = rucRaw.split('\n');
            const ruc = parts[0].trim();
            const razonSocial = parts.length > 1 ? parts[1].trim() : '';
            
            const tipoSerie = getText(2);
            const claveAcceso = getText(3);
            const fechaAutorizacion = getText(4);
            const fechaEmision = getText(5);
            const valorSinImpuestos = getText(6);
            const iva = getText(7);
            const importeTotal = getText(8);
            
            const xmlLink = row.querySelector('a[id*="lnkXml"]');
            
            if (xmlLink) {
              invoices.push({
                numero, ruc, razonSocial, tipoSerie, claveAcceso,
                fechaAutorizacion, fechaEmision, valorSinImpuestos, iva, importeTotal,
                xmlLinkId: xmlLink.id
              });
            }
          }
        } catch (e) {
          // Ignorar fila errónea
        }
      });
      
      return { invoices, count: invoices.length };
    } catch (e) {
      return { error: e.message };
    }
  }

  // 2. Descargar XMLs
  downloadBtn.addEventListener('click', () => {
    if (currentInvoices.length === 0) return;
    processDownloads(currentInvoices);
  });

  // 3. Exportar Excel
  exportBtn.addEventListener('click', () => {
    if (currentInvoices.length === 0) return;
    const csv = convertToCSV(currentInvoices);
    downloadCSV(csv, `reporte_sri_${new Date().toISOString().slice(0,10)}.csv`);
  });

  // 4. Descargar Todo (Paginación)
  downloadAllBtn.addEventListener('click', () => {
    // Lógica compleja delegada al content script
    startBatchDownload();
  });

  // Funciones Helper
  function updateDashboard(invoices) {
    totalInvoicesEl.textContent = invoices.length;
    
    const total = invoices.reduce((sum, inv) => {
      const val = parseFloat(inv.importeTotal.replace(',', '.') || 0);
      return sum + val;
    }, 0);
    
    totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  function renderList(invoices) {
    facturasList.innerHTML = invoices.map(inv => `
      <div class="invoice-item">
        <div class="invoice-info">
          <span style="font-weight:600; font-size:0.8rem;">${inv.razonSocial}</span>
          <span style="color:#64748b; font-size:0.75rem;">${inv.numero}</span>
        </div>
        <div class="invoice-amount">$${inv.importeTotal}</div>
      </div>
    `).join('');
  }

  function updateStatus(text, percent, isError = false) {
    progressContainer.style.display = 'block';
    progressText.textContent = text;
    progressText.style.color = isError ? '#ef4444' : '#64748b';
    progressBar.style.width = `${percent}%`;
    progressBar.style.backgroundColor = isError ? '#ef4444' : '#10b981';
  }

  // Configuración
  const toggleConfigBtn = document.getElementById('toggleConfigBtn');
  const configPanel = document.getElementById('configPanel');
  const folderInput = document.getElementById('folderInput');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const configStatus = document.getElementById('configStatus');

  // Cargar configuración guardada
  chrome.storage.local.get(['downloadFolder'], (result) => {
    if (result.downloadFolder) {
      folderInput.value = result.downloadFolder;
    }
  });

  toggleConfigBtn.addEventListener('click', () => {
    configPanel.style.display = configPanel.style.display === 'none' ? 'block' : 'none';
  });

  saveConfigBtn.addEventListener('click', () => {
    const folder = folderInput.value.trim().replace(/[\\:*?"<>|]/g, ''); // Limpiar caracteres inválidos
    chrome.storage.local.set({ downloadFolder: folder }, () => {
      configStatus.textContent = 'Guardado correctamente ✅';
      configStatus.style.color = '#10b981';
      setTimeout(() => configStatus.textContent = '', 2000);
    });
  });

  async function processDownloads(invoices) {
    updateStatus('Iniciando descargas...', 0);
    
    let completed = 0;
    const total = invoices.length;
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

    // Obtener carpeta configurada
    const { downloadFolder } = await chrome.storage.local.get(['downloadFolder']);

    for (const inv of invoices) {
      try {
        let filename = generateFilename(inv);
        
        // Agregar carpeta si existe
        if (downloadFolder) {
          filename = `${downloadFolder}/${filename}`;
        }

        await chrome.tabs.sendMessage(tab.id, {
          action: 'downloadSingleXML',
          linkId: inv.xmlLinkId,
          filename: filename
        });
        
        completed++;
        updateStatus(`Descargando ${completed}/${total}`, (completed/total)*100);
        
      } catch (e) {
        console.error('Error descargando', inv, e);
      }
      
      await new Promise(r => setTimeout(r, 500));
    }
    
    updateStatus('¡Descarga completada!', 100);
    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 3000);
  }

  function startBatchDownload() {
    updateStatus('Iniciando descarga masiva...', 0);
    
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'downloadAllPages'
      });
    });
  }

  // Escuchar progreso global (para descarga masiva)
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'updateProgress') {
      const percent = (request.current / request.total) * 100;
      updateStatus(`Procesando: ${request.current}/${request.total}`, percent);
    }
  });
});
