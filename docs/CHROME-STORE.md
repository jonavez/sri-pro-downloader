# Preparación de publicación — 16 de noviembre de 2026

Estado: candidato 3.6.0. No enviado ni aprobado por Chrome Web Store.

## Material preparado

- Manifest V3 con permisos limitados al portal SRI y a la API oficial de EMITE.
- Logos oficiales locales, sin fuentes o scripts remotos.
- Política `privacy.html` enlazada desde el popup.
- Aviso visible antes de la sincronización y opción de borrar datos locales.
- ZIP mediante `python3 scripts/package.py`; no subir el ZIP completo del repositorio.
- Diez pruebas con `node --test tests/*.test.mjs`, prueba de extensión cargada con `npm run test:browser` y escaneo mediante `python3 scripts/scan_secrets.py`.

## Pendientes que impiden declarar el producto listo

1. Resolver los controles de integridad del servidor documentados en el informe privado y probar la extensión contra esa versión desplegada.
2. Prueba real autorizada de recibidos y emitidos: más de una página, límites entre páginas, notas de crédito, anulaciones, claves duplicadas, sesión vencida, interrupción de red y cierre del popup. Comparar XML y claves con lo descargado manualmente. Los tests simulados no sustituyen esta prueba.
3. Publicar la política en una URL HTTPS estable accesible sin autenticación y registrar esa URL en el Dashboard; un archivo dentro del ZIP no cubre este requisito.
4. Confirmar la identidad del responsable y los plazos de retención del servicio EMITE, además de los campos de privacidad del Dashboard: datos de identificación, financieros/tributarios, autenticación y contenido web necesario para el propósito declarado. No declarar que la extensión no trata datos de usuario.
5. Revisar el tratamiento de los datos personales presentes en el historial público; el saneamiento local no revoca copias anteriores.
6. Confirmar que 3.6.0 supera la versión máxima del Dashboard; preparar icono de tienda de 128 px, captura de 1280 × 800 o 640 × 400 y mosaico de 440 × 280. Las vistas previas de prueba no acreditan integración real.
7. Subir el ZIP, completar la ficha, proporcionar instrucciones de revisión con datos de prueba y enviar a revisión desde la cuenta del editor. No incluir credenciales de producción ni afirmar afiliación al SRI o certificación ISO.

## Texto de propósito único

Descargar comprobantes XML consultados por el usuario en el portal SRI Ecuador y, cuando lo solicita, sincronizarlos con su empresa en EMITE.ec.

## Evidencia oficial consultada

- [Políticas del programa y privacidad](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Datos del usuario y tratamiento seguro](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Requisitos de imágenes](https://developer.chrome.com/docs/webstore/images)
- [Ciclo de vida del service worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [ISO/IEC 27001:2022](https://www.iso.org/standard/27001)
- [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html)

ISO/IEC 27001 establece requisitos de un sistema de gestión organizacional; una revisión de código no permite certificarlo. ISO/IEC 25010 aporta un modelo de calidad para orientar pruebas y requisitos.
