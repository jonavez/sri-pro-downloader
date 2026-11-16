# SRI Pro Downloader - Reglas para Agentes IA

## Arquitectura del Proyecto

Este proyecto es una **extension de Google Chrome (Manifest V3)** para descarga masiva de comprobantes electronicos XML del SRI Ecuador.

### Estructura de Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `manifest.json` | Configuracion de la extension (MV3) |
| `popup.html` | Estructura HTML del popup |
| `popup.css` | Todos los estilos del popup |
| `popup.js` | Logica principal del popup (entry point) |
| `background.js` | Service Worker: gestiona descargas y seguridad |
| `content.js` | Content Script: extraccion de datos e interaccion con paginas SRI |
| `icons.js` | Modulo de iconos SVG reutilizables |
| `utils.js` | Utilidades compartidas (formateo, generacion de nombres) |
| `excel_export.js` | Exportacion de datos a CSV |

---

## Reglas Obligatorias

### 1. Cero CSS Inline

- **PROHIBIDO** usar `element.style.propiedad = valor` en JavaScript.
- **PROHIBIDO** usar atributos `style=""` en HTML.
- Para valores dinamicos, usar CSS custom properties via `element.style.setProperty('--nombre', valor)`.
- Para cambios de estado visual, usar `classList.add()`, `classList.remove()`, `classList.toggle()`.
- Todos los estilos deben estar en `popup.css` usando clases y tokens de diseno (CSS custom properties en `:root`).

### 2. Cero Emojis

- **PROHIBIDO** usar caracteres emoji (Unicode emoji ranges) en cualquier archivo del proyecto.
- Esto incluye: HTML, JS, CSS, README, y documentacion.
- En su lugar, usar **iconos SVG** del modulo `icons.js`.

### 3. Solo Iconos SVG Reutilizables

- Todos los iconos deben estar definidos en `icons.js` como parte del objeto `ICONS`.
- En HTML, usar `<span class="btn-icon" data-icon="nombreIcono"></span>` o `<span class="social-icon" data-icon="nombreIcono"></span>`.
- La funcion `injectIcons()` se encarga de inyectar los SVGs al cargar el popup.
- **PROHIBIDO** insertar SVGs directamente en el HTML o generarlos desde JS fuera de `icons.js`.

### 4. 100% Componentes Reutilizables

- Cada funcionalidad debe estar encapsulada en su propio modulo JS.
- Los modulos se importan via ES Modules (`import/export`).
- Preferir funciones puras cuando sea posible.
- Evitar duplicacion de logica entre `content.js` y `popup.js`.

### 5. Normas ISO

#### ISO/IEC 27001 - Seguridad de la Informacion

- Validar todas las URLs contra dominios permitidos antes de descargar (`isAllowedUrl()`).
- Sanitizar todos los nombres de archivo para prevenir path traversal (`sanitizeFilename()`).
- Escapar HTML al renderizar datos dinamicos para prevenir XSS (`escapeHtml()`).
- Usar el principio de menor privilegio en permisos del manifest.

#### ISO/IEC 25010 - Calidad del Software

- **Fiabilidad**: Usar colas con TTL para evitar memory leaks (ver `filenameQueue` en `background.js`).
- **Mantenibilidad**: Documentar funciones con JSDoc. Separar responsabilidades por modulo.
- **Portabilidad**: No depender de APIs especificas de un navegador fuera de `chrome.*`.
- **Usabilidad**: Mensajes de error claros y descriptivos en espanol.

#### ISO 9241-210 - Diseno Centrado en el Usuario

- La interfaz debe ser intuitiva y no requerir manual para operaciones basicas.
- Feedback visual inmediato para todas las acciones (progress bars, estados de botones).
- Accesibilidad: usar `aria-label` en elementos interactivos sin texto visible.

### 6. Tokens de Diseno CSS

- Todos los colores deben definirse como CSS custom properties en `:root`.
- No usar colores hardcoded directamente en reglas CSS (excepto en `:root`).
- Los tokens existentes son: `--primary`, `--primary-hover`, `--secondary`, `--success`, `--success-hover`, `--error`, `--whatsapp`, `--whatsapp-hover`, `--bg`, `--card-bg`, `--text`, `--text-light`, `--border`, `--shadow-sm`, `--shadow-md`.

### 7. Convencion de Nombres CSS

- BEM-like: `.componente`, `.componente--modificador`, `.componente__elemento`.
- Clases utilitarias: `.hidden`, `.visually-hidden`.
- Prefijos por contexto: `.btn-*`, `.config-*`, `.invoice-*`, `.social-*`, `.progress-*`.

### 8. Informacion de Contacto

- WhatsApp: `593958900756` (Jonathan Chavez)
- Sitio web: `https://nuro.ec`
- Redes sociales: `@nurolatam` en Facebook, Instagram, X, TikTok, LinkedIn, YouTube

### 9. Documentacion

- Todo el codigo debe estar documentado en espanol.
- Usar JSDoc para funciones publicas.
- Los comentarios de seccion usan el formato: `// --- Titulo ---` o `/* --- Titulo --- */`.
- El README no debe contener emojis.

### 10. Versionado del Manifest (Chrome Web Store)

- La version en `manifest.json` **SIEMPRE** debe ser mayor que la version publicada en Chrome Web Store.
- Usar versionado semantico: `MAJOR.MINOR.PATCH` (ej: `3.1.0`).
- **Antes de cada publicacion**, incrementar la version en `manifest.json`.
- Si se recibe el error _"No es valido el numero de version"_, significa que la version ya existe en Chrome Web Store y debe incrementarse.
- Regla de incremento:
  - `PATCH` (+0.0.1): Correcciones de bugs, ajustes menores.
  - `MINOR` (+0.1.0): Nuevas funcionalidades, cambios de UI.
  - `MAJOR` (+1.0.0): Cambios de arquitectura, breaking changes.
- Actualizar tambien la referencia de version en `background.js` (log de instalacion) y `README.md` cuando se incremente.
