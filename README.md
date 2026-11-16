# SRI Pro Downloader

**SRI Pro Downloader** es una extension profesional para Google Chrome (v3.5.0) disenada para facilitar la descarga masiva, gestion y sincronizacion automatizada de comprobantes electronicos (XML) tanto emitidos como recibidos desde el portal del SRI en Linea (Ecuador) hacia la plataforma de facturacion en la nube **EMITE.ec**.

---

## Caracteristicas (v3.5.0)

- **Escanear Todas las Paginas (Multi-Pagina)**: Crawler inteligente que recorre iterativamente el paginador de PrimeFaces del SRI, recolectando y deduplicando cientos de facturas en todas las paginas con feedback en tiempo real.
- **Sincronizacion en 1 Clic con EMITE.ec**: Sincroniza directamente todos tus comprobantes consultados en el SRI hacia tu empresa en EMITE.ec sin necesidad de descargar archivos a tu disco local.
- **Extraccion de XML Ultra-Resiliente**: Envio de solicitudes JSF urlencoded nativas desde la sesion autenticada del navegador, garantizando la obtencion directa del XML y eliminando dependencias de servicios SOAP externos.
- **Navegacion Asistida durante la Ingesta**: Para consultas multi-pagina, la extension posiciona la vista de la tabla en la pagina adecuada para extraer el XML en milisegundos antes del envio a la API.
- **Deteccion Inteligente de Duplicadas**: Algoritmo diferencial en dos fases (Pre-check) que consulta la base de datos de EMITE.ec y omite facturas previamente registradas, ahorrando ancho de banda y tiempo.
- **Deteccion de Facturas Anuladas**: Identifica comprobantes marcados como anulados o cancelados en el SRI y actualiza su estado en EMITE.ec de forma automatizada.
- **Clasificacion de Notas de Credito**: Identifica notas de credito (`cod_doc = '04'`), asociandolas con el comprobante sustento correspondiente de forma no destructiva.
- **Soporte Multicomprobante**: Facturas (`01`), Liquidaciones de compra (`03`), Notas de credito (`04`), Notas de debito (`05`), Guias de remision (`06`) y Retenciones (`07`).
- **Descarga Masiva a Disco**: Descarga multiples facturas XML con un solo clic si prefieres guardarlas localmente.
- **Renombrado Inteligente**: Guarda tus archivos automaticamente con el formato `RUC_FECHA_SECUENCIAL.xml` para contabilidad organizada.
- **Exportacion a Excel (CSV)**: Genera reportes CSV de tus comprobantes al instante.
- **Robustez con Regex de 49 Digitos**: Extrae claves de acceso desacopladas de indices rigidos de celda en PrimeFaces.
- **Seguridad ISO/IEC 27001**: Autenticacion segura mediante API Key (`X-API-Key`), almacenamiento en `storage.local` y validacion estricta de aislamiento multi-tenant.
- **Arquitectura Elephant-Goldfish Model (EGM)**: Diseno y especificaciones auditadas bajo el estandar formal de Google EGM (`docs/designs/`).

---

## Instalacion

1. Descarga el codigo de este repositorio (ZIP) o clonalo:
   ```bash
   git clone https://github.com/jonavez/sri-pro-downloader.git
   ```
2. Abre Google Chrome y ve a `chrome://extensions/`.
3. Activa el **"Modo de desarrollador"** en la esquina superior derecha (interruptor azul).
4. Haz clic en el boton **"Cargar descomprimida"** (Load unpacked).
5. Selecciona la carpeta donde descargaste este proyecto.

---

## Como Usar

### 1. Sincronizar Directamente con EMITE.ec (Recomendado)

1. Haz clic en el icono de engranaje en la extension.
2. En la seccion **Plataforma EMITE.ec**:
   - Ingresa la URL de la API (por defecto: `https://api.emite.ec`).
   - Pega la **API Key** de tu empresa generada en EMITE.ec.
   - Presiona **"Probar Conexion"** para verificar el enlace con tu razon social.
   - Presiona **"Guardar"**.
3. Ingresa al portal del [SRI en Linea](https://srienlinea.sri.gob.ec/) -> Facturacion Electronica -> Comprobantes Recibidos.
4. Realiza tu consulta (por mes, anio, dia, etc.) y presiona "Consultar".
5. Abre la extension **SRI Pro Downloader**, presiona **"Escanear Pagina Actual"** y haz clic en **"Sincronizar con EMITE.ec"**.
6. Observa la barra de progreso y la tarjeta de resultados: veras exactamente cuantas facturas nuevas fueron sincronizadas, cuantas duplicadas fueron omitidas y cuantas anuladas fueron detectadas.

### 2. Descargar XMLs Localmente

- Presiona **"Descargar XMLs"** para bajar los archivos de la pagina actual a tu carpeta configurada de descargas.
- O usa **"Descargar Todas las Paginas"** para que la extension navegue automaticamente por todas las paginas de resultados.
- Presiona **"Exportar a Excel (CSV)"** para generar una hoja de calculo con los montos e impuestos detallados.

---

## Documentacion y Especificaciones EGM

Las especificaciones tecnicas completas y los contratos de API auditados por la suite de revisores EGM se encuentran en:
- [docs/designs/sincronizacion_emite.md](docs/designs/sincronizacion_emite.md)
- [docs/designs/SITEMAP.md](docs/designs/SITEMAP.md)

---

## Contribuye

Si esta herramienta te ha sido util y te ha ahorrado tiempo en tus declaraciones de impuestos:

- **Dale una estrella** a este repositorio.
- Si encuentras un error, abre un [Issue](https://github.com/jonavez/sri-pro-downloader/issues).

---

## Redes Sociales

Siguenos en nuestras redes sociales como **nurolatam**:

- [Facebook](https://facebook.com/nurolatam)
- [Instagram](https://instagram.com/nurolatam)
- [X (Twitter)](https://x.com/nurolatam)
- [TikTok](https://tiktok.com/@nurolatam)
- [LinkedIn](https://linkedin.com/company/nurolatam)
- [YouTube](https://youtube.com/@nurolatam)

---

## Contacto

- **GitHub**: [Jonathan Chavez](https://github.com/jonavez)
- **WhatsApp**: [+593 958 900 756](https://wa.me/593958900756)
- **Web**: [https://nuro.ec](https://nuro.ec)

---

Desarrollado por [Jonathan Chavez](https://github.com/jonavez) | [nuro](https://nuro.ec)
