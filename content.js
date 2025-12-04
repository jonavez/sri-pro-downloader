// content.js - Lógica de extracción e interacción con la página

function extractInvoiceData() {
  console.log('SRI Pro Downloader: Iniciando extracción...');
  const invoices = [];
  
  // Intento 1: Selector específico por ID (común en JSF/PrimeFaces)
  let rows = document.querySelectorAll('table[id*="tablaCompRecibidos"] tbody tr[data-ri]');
  
  // Intento 2: Búsqueda genérica de filas PrimeFaces
  if (rows.length === 0) {
    console.log('SRI Pro: Selector específico no encontró nada. Probando selector genérico...');
    rows = document.querySelectorAll('tbody tr[data-ri]');
  }

  if (rows.length === 0) {
    console.warn('SRI Pro: No se encontraron filas de facturas.');
    return { invoices: [], total: 0, error: 'No se encontraron filas de facturas en la pantalla.' };
  }
  
  console.log(`SRI Pro: Encontradas ${rows.length} filas.`);

  rows.forEach((row, index) => {
    try {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 8) { // Bajamos el umbral por si acaso
        // Extracción robusta
        const numero = cells[0].innerText.trim();
        const rucRaw = cells[1].innerText.trim(); 
        const parts = rucRaw.split('\n');
        const ruc = parts[0].trim();
        const razonSocial = parts.length > 1 ? parts[1].trim() : '';
        
        // Índices pueden variar si hay columnas ocultas, pero asumimos estándar SRI
        const tipoSerie = cells[2] ? cells[2].innerText.trim() : '';
        const claveAcceso = cells[3] ? cells[3].innerText.trim() : '';
        const fechaAutorizacion = cells[4] ? cells[4].innerText.trim() : '';
        const fechaEmision = cells[5] ? cells[5].innerText.trim() : '';
        const valorSinImpuestos = cells[6] ? cells[6].innerText.trim() : '0.00';
        const iva = cells[7] ? cells[7].innerText.trim() : '0.00';
        const importeTotal = cells[8] ? cells[8].innerText.trim() : '0.00';
        
        // Buscar botón/link XML
        const xmlLink = row.querySelector('a[id*="lnkXml"]');
        
        if (xmlLink) {
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
            xmlLinkId: xmlLink.id,
            rowIndex: index
          });
        }
      }
    } catch (e) {
      console.error('Error parsing row', e);
    }
  });
  
  console.log(`SRI Pro: Extraídas ${invoices.length} facturas válidas.`);
  return { invoices, total: invoices.length };
}

// Simular clic y manejar descarga
async function downloadSingleXML(linkId, filename) {
  const link = document.getElementById(linkId);
  if (!link) return false;

  // 1. Avisar al background qué nombre queremos para la próxima descarga
  // Esto es crucial para los links JSF/PrimeFaces que no tienen URL directa
  if (filename) {
    try {
      await chrome.runtime.sendMessage({
        action: 'expectDownload',
        filename: filename
      });
    } catch (e) {
      console.warn('No se pudo avisar al background:', e);
    }
  }

  const href = link.getAttribute('href');
  
  if (href && href !== '#' && !href.startsWith('javascript:')) {
    // Es un link directo, enviamos al background para descarga explícita
    chrome.runtime.sendMessage({
      action: 'downloadFile',
      url: link.href,
      filename: filename
    });
  } else {
    // Es un JS o PrimeFaces action (POST back)
    // Al hacer clic, el navegador iniciará la descarga.
    // El background interceptará onDeterminingFilename y usará el nombre que acabamos de enviar.
    link.click();
  }
  
  // Esperar un poco para asegurar que el evento se procese
  await new Promise(r => setTimeout(r, 2000));
  return true;
}

// Navegación
function hasNextPage() {
  const nextBtn = document.querySelector('.ui-paginator-next');
  return nextBtn && !nextBtn.classList.contains('ui-state-disabled');
}

async function goToNextPage() {
  const nextBtn = document.querySelector('.ui-paginator-next');
  if (nextBtn) {
    nextBtn.click();
    // Esperar a que cargue la tabla (spinner desaparezca o tabla cambie)
    await new Promise(r => setTimeout(r, 3000)); 
  }
}

// Listeners
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractInvoices') {
    sendResponse(extractInvoiceData());
  }
  
  if (request.action === 'downloadSingleXML') {
    downloadSingleXML(request.linkId, request.filename)
      .then(() => sendResponse({success: true}))
      .catch(e => sendResponse({success: false, error: e.message}));
    return true;
  }
  
  if (request.action === 'downloadAllPages') {
    processAllPages();
    sendResponse({started: true});
  }
});

async function processAllPages() {
  let page = 1;
  let totalProcessed = 0;
  
  // Importar utils dinámicamente para generar nombres
  let utils;
  try {
    utils = await import(chrome.runtime.getURL('utils.js'));
  } catch (e) {
    console.error('Error importando utils:', e);
  }

  // Obtener carpeta configurada
  let downloadFolder = '';
  try {
    const storage = await chrome.storage.local.get(['downloadFolder']);
    downloadFolder = storage.downloadFolder || '';
  } catch (e) {
    console.warn('Error leyendo storage:', e);
  }
  
  while (true) {
    const data = extractInvoiceData();
    const invoices = data.invoices;
    
    // Descargar de esta página
    for (let i = 0; i < invoices.length; i++) {
      let filename = '';
      if (utils) {
        filename = utils.generateFilename(invoices[i]);
        if (downloadFolder) {
          filename = `${downloadFolder}/${filename}`;
        }
      }

      await downloadSingleXML(invoices[i].xmlLinkId, filename);
      totalProcessed++;
      
      // Reportar progreso
      chrome.runtime.sendMessage({
        action: 'updateProgress',
        current: totalProcessed,
        total: '?' // Desconocido total real
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
    action: 'updateProgress',
    current: totalProcessed,
    total: totalProcessed
  });
}
