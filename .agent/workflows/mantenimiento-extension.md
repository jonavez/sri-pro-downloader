---
description: Workflow para mantenimiento y mejora de la extensión SRI Pro Downloader
---

# Workflow de Mantenimiento - SRI Pro Downloader

Este workflow define los pasos para realizar mejoras, correcciones y actualizaciones en la extensión.

## 1. Preparación del Entorno
- Asegúrate de tener la extensión cargada en Chrome en modo desarrollador (`chrome://extensions`).
- Si vas a trabajar en la UI, abre `popup.html` en el navegador para visualizar cambios rápidamente, aunque algunas funciones de Chrome API no funcionarán fuera del contexto de extensión.
- Para probar la extracción de datos sin acceso al SRI, utiliza `mock_sri.html`.

## 2. Estándares de Código
- **Idioma**: Todo el código, comentarios y documentación debe estar en **ESPAÑOL**.
- **Estilo**:
  - JS: ES6+, usar `const`/`let`, funciones flecha.
  - CSS: Variables CSS para temas, Flexbox/Grid para layouts.
  - HTML: Semántico.

## 3. Proceso de Desarrollo de Nuevas Features
1. **Planificación**:
   - Definir la nueva funcionalidad en `task.md`.
   - Actualizar `implementation_plan.md` si es un cambio mayor.

2. **Implementación**:
   - Si afecta la UI: Modificar `popup.html` y `popup.css` (o estilos en línea si es pequeño, pero preferible CSS separado).
   - Si afecta la lógica de fondo: Modificar `background.js`.
   - Si afecta la extracción: Modificar `content.js`.

3. **Pruebas**:
   - Cargar `mock_sri.html` en el navegador.
   - Verificar que `content.js` extrae los datos correctamente.
   - Verificar que el popup muestra la información.
   - Probar exportación y descarga.

4. **Release**:
   - Actualizar versión en `manifest.json`.
   - Generar zip para distribución.

## 4. Comandos Útiles
- Recargar extensión: Ir a `chrome://extensions` y dar clic en el icono de recarga.
- Debugging:
  - Popup: Clic derecho en el icono de la extensión -> Inspeccionar.
  - Content Script: Inspeccionar elemento en la página del SRI -> Consola.
  - Background: En `chrome://extensions`, clic en "Service Worker" (si está activo).

## 5. UX/UI Guidelines
- **Colores**:
  - Primario: `#2563eb` (Azul moderno)
  - Éxito: `#10b981` (Verde esmeralda)
  - Error: `#ef4444` (Rojo suave)
  - Fondo: `#f8fafc` (Gris muy claro)
- **Tipografía**: Inter o system-ui.
- **Componentes**:
  - Botones con `border-radius: 8px`, transición suave en hover.
  - Tarjetas con `box-shadow` sutil.
