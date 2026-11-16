# Contrato público de sincronización

Base única: `https://api.emite.ec`. Autenticación: `X-API-Key` de la empresa; nunca incluirla en URLs, documentación, logs ni ejemplos reales.

| Método | Ruta bajo `/api/v1/facturas-recibidas/sincronizar` | Uso |
| --- | --- | --- |
| GET | `/verificar-conexion` | Mostrar la empresa vinculada antes del envío |
| POST | `/pre-check` | Clasificar comprobantes nuevos, duplicados y anulados |
| POST | `/ingestar-claves` | Enviar hasta tres comprobantes con `clave_acceso` y `xml_content` |
| POST | `/actualizar-anuladas` | Actualizar hasta 50 claves por petición |

Los POST incluyen `tipo_sincronizacion`: `RECIBIDOS` o `EMITIDOS`. El pre-check transmite los metadatos tributarios de la consulta; la ingesta transmite sólo XML obtenidos desde la sesión del usuario. Un fallo al obtener XML se muestra para reintentar y no se convierte en una consulta SOAP automática.

La extensión valida el destino HTTPS exacto y rechaza redirecciones. El timeout de API es de 25 segundos, incluida la lectura del cuerpo; no se realizan reintentos automáticos de escrituras. Ante una respuesta incierta, repetir el proceso requiere el pre-check y la idempotencia del servidor.

El servidor conserva la responsabilidad de validar todas las entradas, el estado del documento y el aislamiento por empresa. Los estados mostrados por la extensión reflejan la respuesta del servidor y no certifican la autorización tributaria. La validación funcional contra producción requiere una sesión y datos de prueba autorizados.
