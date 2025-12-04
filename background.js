import { generateFilename } from './utils.js';

let nextDownloadFilename = null;

// Escuchar mensajes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadFile') {
    handleDownload(request.url, request.filename, sendResponse);
    return true;
  }
  
  if (request.action === 'expectDownload') {
    nextDownloadFilename = request.filename;
    console.log('Esperando descarga:', nextDownloadFilename);
    sendResponse({ received: true });
    return false;
  }
});

// Interceptar nombres de archivo
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (nextDownloadFilename) {
    console.log('Asignando nombre:', nextDownloadFilename, 'a descarga:', item.id);
    suggest({
      filename: nextDownloadFilename,
      conflictAction: 'uniquify'
    });
    nextDownloadFilename = null; // Resetear para la siguiente
  } else {
    // Si no hay nombre esperado, dejar que el navegador decida (o aplicar lógica default)
    suggest();
  }
});

// Manejar la descarga explícita (URL directa)
function handleDownload(url, filename, sendResponse) {
  chrome.downloads.download({
    url: url,
    filename: filename,
    conflictAction: 'uniquify',
    saveAs: false // Intentar evitar el prompt
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      sendResponse({ success: false, error: chrome.runtime.lastError.message });
    } else {
      sendResponse({ success: true, downloadId: downloadId });
    }
  });
}

// Instalación
chrome.runtime.onInstalled.addListener(() => {
  console.log('SRI Pro Downloader instalado correctamente.');
});
