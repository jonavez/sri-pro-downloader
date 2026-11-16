# SRI Pro XML 3.6.0

Extensión Chrome Manifest V3 para descargar comprobantes XML de consultas del SRI Ecuador y sincronizarlos, por solicitud del usuario, con su empresa en EMITE.ec. Herramienta independiente, sin afiliación oficial con el SRI.

## Uso

1. Carga esta carpeta desde `chrome://extensions` con el modo de desarrollador activado.
2. Inicia sesión directamente en `https://srienlinea.sri.gob.ec/` y consulta comprobantes recibidos o emitidos.
3. Abre la extensión y escanea la página actual o todas las páginas. El recorrido tiene un máximo de 50 páginas: reduce el período de consulta si lo superas.
4. Descarga los XML o exporta el CSV. Mantén abierta la pestaña del SRI durante las operaciones. Las descargas continúan al cerrar el popup.
5. Para sincronizar, guarda la API Key de tu empresa, prueba la conexión y comprueba la empresa mostrada antes de pulsar Sincronizar. Sólo se permite `https://api.emite.ec`.

La sincronización utiliza pre-check diferencial y lotes de hasta tres XML de una misma página. Si el XML no se obtiene desde el navegador, el comprobante queda fallido para reintentar; no se dispara automáticamente una consulta SOAP. Ante una interrupción de Chrome se conserva el último resultado y se solicita volver a escanear y sincronizar. El backend comprueba duplicados al reintentar. No se promete latencia fija ni éxito del 100 %: ambos dependen del portal, la sesión, la red y el servidor.

## Privacidad y permisos

Consulta [la política de privacidad](privacy.html). La API Key permanece en almacenamiento local del perfil, sin cifrado adicional; el acceso desde content scripts está restringido. No se usa Chrome Sync ni analítica. Las credenciales y los resultados locales pueden borrarse desde el popup. Esto no elimina archivos descargados ni registros enviados a EMITE.

- `activeTab` y `scripting`: localizar la consulta e inicializar el script en el frame correcto tras una acción del usuario.
- `downloads`: iniciar descargas XML y asignar nombres.
- `storage`: configuración, credenciales locales y último resultado.
- Hosts: exclusivamente el portal HTTPS `srienlinea.sri.gob.ec` y `api.emite.ec`.

## Verificación y entrega

```sh
npm ci --ignore-scripts
node --test tests/*.test.mjs
npx playwright install chromium
npm run test:browser
python3 scripts/scan_secrets.py
python3 scripts/package.py
```

El ZIP de `dist/` incluye sólo archivos de ejecución y logos; excluye historial Git, documentación de desarrollo, pruebas, credenciales e informes. Revisa [el informe de auditoría](docs/AUDIT-2026-11-16.md) y [los requisitos de publicación](docs/CHROME-STORE.md) antes de enviar a la tienda. La versión 3.6.0 supera la del repositorio auditado (3.5.0); debe contrastarse con el Dashboard antes del envío.

Se toman como referencia ISO/IEC 27001:2022, ISO/IEC 25010:2023 e ISO 9241-210. No se declara certificación ISO ni aprobación de Chrome Web Store. Los controles de código no constituyen por sí solos un sistema de gestión certificado.

## nuro y EMITE.ec

[nuro](https://nuro.ec) es la empresa detrás de este proyecto y de [EMITE.ec](https://emite.ec), la plataforma de facturación electrónica con la que se integra la extensión.

- [nuro.ec](https://nuro.ec): conoce la empresa y sus soluciones tecnológicas.
- [emite.ec](https://emite.ec): accede a la plataforma de facturación electrónica.

Los logos EMITE.ec se reutilizan de los recursos oficiales públicos del producto, con variantes para fondos claros y oscuros. No contienen datos de configuración del servidor.

Desarrollo: [nuro](https://nuro.ec). Soporte: [WhatsApp](https://wa.me/593958900756). No publiques XML, identificaciones tributarias reales ni API Keys en incidencias públicas.
