/**
 * Utilidades compartidas para SRI Pro Downloader
 */

// Formatear fecha para nombres de archivo (DD_MM_YYYY)
export function formatDateForFilename(dateString) {
  // Asume formato de entrada DD/MM/YYYY o DD/MM/YYYY HH:MM
  if (!dateString) return 'fecha_desconocida';
  
  const parts = dateString.split(' ')[0].split('/');
  if (parts.length === 3) {
    return `${parts[0]}_${parts[1]}_${parts[2]}`;
  }
  return dateString.replace(/\//g, '_');
}

// Validar si un string parece ser un RUC válido (simple check de longitud)
export function isValidRuc(ruc) {
  return ruc && /^\d{13}$/.test(ruc);
}

// Generar nombre de archivo estandarizado
export function generateFilename(invoice, format = 'RUC_FECHA_SECUENCIAL') {
  const ruc = invoice.ruc || 'SIN_RUC';
  const fecha = formatDateForFilename(invoice.fechaEmision);
  const secuencial = invoice.numero ? invoice.numero.replace(/-/g, '') : 'SIN_NUMERO';
  const razonSocial = (invoice.razonSocial || 'SIN_RAZON').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);

  switch (format) {
    case 'RUC_FECHA_SECUENCIAL':
      return `${ruc}_${fecha}_${secuencial}.xml`;
    case 'FECHA_RUC_SECUENCIAL':
      return `${fecha}_${ruc}_${secuencial}.xml`;
    case 'RAZON_FECHA':
      return `${razonSocial}_${fecha}_${secuencial}.xml`;
    default:
      return `${ruc}_${fecha}_${secuencial}.xml`;
  }
}

// Esperar un tiempo determinado (promesa)
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Convierte importes del portal con separadores latinos o decimales de punto. */
export function parseSriAmount(value) {
  let text = String(value ?? "0").replace(/[$\s]/g, "");
  if (text.includes(",") && text.includes(".")) {
    text = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : 0;
}
