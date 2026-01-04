/**
 * Módulo para exportar datos a CSV/Excel
 */

export function convertToCSV(invoices) {
  if (!invoices || invoices.length === 0) {
    return '';
  }

  // Definir encabezados
  const headers = [
    'Número',
    'RUC Emisor',
    'Razón Social',
    'Tipo Documento',
    'Fecha Emisión',
    'Fecha Autorización',
    'Clave Acceso',
    'Subtotal',
    'IVA',
    'Total'
  ];

  // Crear filas
  const rows = invoices.map(inv => [
    `"${inv.numero}"`,
    `"${inv.ruc}"`,
    `"${inv.razonSocial}"`,
    `"${inv.tipoSerie}"`,
    `"${inv.fechaEmision}"`,
    `"${inv.fechaAutorizacion}"`,
    `"${inv.claveAcceso}"`,
    `"${inv.valorSinImpuestos}"`,
    `"${inv.iva}"`,
    `"${inv.importeTotal}"`
  ]);

  // Unir todo
  return [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');
}

export function downloadCSV(csvContent, filename = 'reporte_facturas.csv') {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
