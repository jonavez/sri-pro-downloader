# Guia de Implementacion para el Agente Backend (`facturador-ec/api`)

**Destinatario**: Agente de Inteligencia Artificial / Desarrollador Backend a cargo de `/Users/jona/emite/facturador-ec/api`  
**Version**: 2.0.0 (Soporte Dual: Comprobantes Emitidos y Recibidos)  
**Objetivo**: Implementar el soporte para sincronizar tanto comprobantes **Recibidos** como **Emitidos** (ventas) desde la extension Chrome `sri-pro-downloader` (v3.4.0).  

---

## 1. Diagnostico de Errores Reportados y Causa Raiz

### Error A: Rechazo por Aislamiento Multi-Tenant en Facturas Emitidas
```text
Causa del fallo: El comprobante fue emitido a 9999999999999, no a CHAVEZ CARPIO JONATHAN DIONICIO (2200345284001) | El comprobante fue emitido a EXTERIOR, no a CHAVEZ CARPIO JONATHAN DIONICIO (2200345284001)
```
- **Causa Raiz**: En `api/app/api/endpoints/sincronizacion_extension.py` (linea 249), la validacion multi-tenant actual evalua:
  `identificacion_corresponde(leido.receptor_identificacion, empresa.ruc)`
  Esto es correcto **exclusivamente para comprobantes recibidos** (donde el tenant es el comprador/receptor).
  En **comprobantes emitidos** (ventas), el tenant es el **emisor** (`leido.emisor_ruc`), mientras que el receptor es el cliente (`9999999999999` consumidor final, cliente del exterior, o cedula/RUC de terceros). Por ende, la validacion actual rechaza erroneamente todas las ventas emitidas.

### Error B: SRI SOAP Offline / RECHAZADA
```text
Causa del fallo: El SRI reporta estado: RECHAZADA (WAF/SOAP offline)
```
- **Causa Raiz**: Ocurre cuando el backend no recibe `xml_content` en la solicitud de ingesta y recurre a la llamada SOAP remota `cliente.autorizar_comprobante(clave)`. Los servidores del SRI (`cel.sri.gob.ec`) bloquean frecuentemente IPs de centros de datos extranjeros (WAF de Cloudflare/SRI) o presentan timeouts.
- **Solucion**: La extension v3.4.0 ahora extrae el XML directamente de la sesion autenticada del navegador del usuario en el SRI mediante `executeScript` multi-frame. El backend debe **priorizar siempre el `xml_content` recibido** y parsearlo con `leer_comprobante()`, omitiendo por completo la llamada SOAP cuando el XML esta presente.

---

## 2. Requerimientos de Implementacion en Backend (`facturador-ec/api`)

Los cambios se deben aplicar en:
[`api/app/api/endpoints/sincronizacion_extension.py`](file:///Users/jona/emite/facturador-ec/api/app/api/endpoints/sincronizacion_extension.py)

### 2.1 Actualizacion de Esquemas Pydantic

```python
class ItemComprobantePreCheck(BaseModel):
    clave_acceso: str = Field(..., min_length=49, max_length=49)
    cod_doc: str = Field(..., min_length=2, max_length=2)
    emisor_ruc: str
    emisor_nombre: Optional[str] = ""
    total: float
    fecha_emision: str
    estado_portal: Optional[str] = "AUTORIZADO"
    es_emitido: Optional[bool] = False


class PreCheckRequest(BaseModel):
    comprobantes: List[ItemComprobantePreCheck]
    tipo_sincronizacion: Optional[str] = "RECIBIDOS"  # "RECIBIDOS" o "EMITIDOS"


class ItemComprobanteIngesta(BaseModel):
    clave_acceso: str
    xml_content: Optional[str] = None
    ambiente: Optional[int] = 2


class IngestarClavesRequest(BaseModel):
    claves_acceso: Optional[List[str]] = None
    comprobantes: Optional[List[ItemComprobanteIngesta]] = None
    ambiente: Optional[int] = 2
    tipo_sincronizacion: Optional[str] = "RECIBIDOS"  # "RECIBIDOS" o "EMITIDOS"
```

---

### 2.2 Endpoint `POST /api/v1/facturas-recibidas/sincronizar/pre-check`

Cuando `tipo_sincronizacion == "EMITIDOS"`:
1. Buscar duplicados en la tabla `comprobantes` (modelo `Comprobante`) donde `tenant_id == empresa.id` y `estado != 'RECHAZADA'`.
2. Las claves no encontradas van a `por_sincronizar`.

```python
@router.post("/sincronizar/pre-check")
async def pre_check_comprobantes(
    request: PreCheckRequest,
    db: Session = Depends(deps.get_db),
    empresa: Empresa = Depends(deps.get_current_tenant_or_api_key),
):
    """Compara en base de datos las claves enviadas para clasificar duplicadas, anuladas y nuevas.
    Soporta tanto comprobantes RECIBIDOS como EMITIDOS.
    """
    claves = [c.clave_acceso for c in request.comprobantes]
    if not claves:
        return {
            "total_analizados": 0,
            "duplicadas": [],
            "por_sincronizar": [],
            "anuladas_detectadas": [],
            "resumen": {
                "total": 0,
                "duplicadas_count": 0,
                "por_sincronizar_count": 0,
                "anuladas_count": 0,
            },
        }

    es_emitidos = request.tipo_sincronizacion == "EMITIDOS"

    duplicadas = []
    por_sincronizar = []
    anuladas_detectadas = []

    if es_emitidos:
        # Pre-check para facturas emitidas: consultar tabla comprobantes
        existentes_db = db.execute(
            select(Comprobante.clave_acceso, Comprobante.estado).where(
                Comprobante.tenant_id == empresa.id,
                Comprobante.clave_acceso.in_(claves),
                Comprobante.estado != "RECHAZADA",
            )
        ).all()
        mapa_existentes = {row[0]: row[1] for row in existentes_db}

        for c in request.comprobantes:
            clave = c.clave_acceso
            if clave in mapa_existentes:
                duplicadas.append({
                    "clave_acceso": clave,
                    "origen": "comprobantes_emitidos",
                    "estado_actual": mapa_existentes[clave],
                })
            else:
                por_sincronizar.append({
                    "clave_acceso": clave,
                    "cod_doc": c.cod_doc,
                    "emisor_ruc": c.emisor_ruc,
                    "total": c.total,
                })
    else:
        # Pre-check para facturas recibidas (comportamiento existente)
        existentes_db = db.execute(
            select(FacturaRecibida.clave_acceso, FacturaRecibida.estado_sri).where(
                FacturaRecibida.tenant_id == empresa.id,
                FacturaRecibida.clave_acceso.in_(claves),
            )
        ).all()
        mapa_existentes = {row[0]: row[1] for row in existentes_db}

        internas_db = (
            db.execute(
                select(Comprobante.clave_acceso)
                .join(Cliente, Comprobante.cliente_id == Cliente.id)
                .where(
                    Cliente.identificacion == empresa.ruc,
                    Comprobante.clave_acceso.in_(claves),
                    Comprobante.estado == "AUTORIZADA",
                )
            )
            .scalars()
            .all()
        )
        set_internas = set(internas_db)

        for c in request.comprobantes:
            clave = c.clave_acceso
            if clave in mapa_existentes:
                estado_actual = mapa_existentes[clave]
                estado_portal_limpio = (c.estado_portal or "").strip().upper()
                if estado_portal_limpio in ("ANULADO", "ANULADA") and estado_actual != "ANULADA":
                    anuladas_detectadas.append({
                        "clave_acceso": clave,
                        "estado_anterior": estado_actual,
                        "estado_portal": "ANULADO",
                    })
                else:
                    duplicadas.append({
                        "clave_acceso": clave,
                        "origen": "facturas_recibidas",
                        "estado_actual": estado_actual,
                    })
            elif clave in set_internas:
                duplicadas.append({
                    "clave_acceso": clave,
                    "origen": "sistema_interno",
                    "estado_actual": "AUTORIZADA",
                })
            else:
                por_sincronizar.append({
                    "clave_acceso": clave,
                    "cod_doc": c.cod_doc,
                    "emisor_ruc": c.emisor_ruc,
                    "total": c.total,
                })

    return {
        "total_analizados": len(request.comprobantes),
        "duplicadas": duplicadas,
        "por_sincronizar": por_sincronizar,
        "anuladas_detectadas": anuladas_detectadas,
        "resumen": {
            "total": len(request.comprobantes),
            "duplicadas_count": len(duplicadas),
            "por_sincronizar_count": len(por_sincronizar),
            "anuladas_count": len(anuladas_detectadas),
        },
    }
```

---

### 2.3 Endpoint `POST /api/v1/facturas-recibidas/sincronizar/ingestar-claves`

Cuando `tipo_sincronizacion == "EMITIDOS"`:
1. **Validacion Multi-Tenant Invertida**: Validar que el **emisor** coincida con la empresa activa:
   `identificacion_corresponde(leido.emisor_ruc, empresa.ruc)`
2. **Ingesta en Venta**: Delegar a `ServicioImportacionEmitidas.importar(...)` existente en `app.services.facturacion.importador_comprobantes`.

```python
from app.services.facturacion.importador_comprobantes import ServicioImportacionEmitidas

@router.post("/sincronizar/ingestar-claves")
def ingestar_claves_sri(
    request: IngestarClavesRequest,
    db: Session = Depends(deps.get_db),
    empresa: Empresa = Depends(deps.get_current_tenant_or_api_key),
):
    """Consulta al SRI o procesa directamente XML e ingesta comprobantes.
    Soporta comprobantes RECIBIDOS y comprobantes EMITIDOS.
    """
    items: List[ItemComprobanteIngesta] = []
    if request.comprobantes:
        items.extend(request.comprobantes)
    elif request.claves_acceso:
        for c in request.claves_acceso:
            items.append(ItemComprobanteIngesta(clave_acceso=c, ambiente=request.ambiente or 2))

    if len(items) > 5:
        raise HTTPException(
            status_code=422,
            detail="Por seguridad y tolerancia a timeouts, se permite un maximo de 5 comprobantes por lote.",
        )

    es_emitidos = request.tipo_sincronizacion == "EMITIDOS"
    cliente = None
    guardados = []
    fallidos = []

    for item in items:
        clave = item.clave_acceso
        xml_directo = item.xml_content
        try:
            resp = {}
            if xml_directo:
                xml_bytes_str = xml_directo
                estado = "AUTORIZADO"
            else:
                if cliente is None:
                    cliente = ClienteSoapSRI(
                        ambiente=item.ambiente or request.ambiente or empresa.ambiente_sri or 2,
                        timeout=8
                    )
                try:
                    resp = cliente.autorizar_comprobante(clave, reintentar=False)
                except Exception as e_soap:
                    logger.warning(f"Error o timeout consultando SOAP SRI para clave {clave}: {e_soap}")
                    fallidos.append({
                        "clave_acceso": clave,
                        "error": "El SRI no responde a tiempo (timeout SOAP)",
                        "reintentable": True,
                    })
                    continue

                estado = (resp.get("estado") or "").strip().upper()
                xml_bytes_str = resp.get("xml_autorizado")

                if estado != "AUTORIZADO" or not xml_bytes_str:
                    fallidos.append({
                        "clave_acceso": clave,
                        "error": f"El SRI reporta estado: {estado or 'SIN RESPUESTA'} (WAF/SOAP offline)",
                        "reintentable": True,
                    })
                    continue

            # Parseo del XML seguro
            xml_bytes = xml_bytes_str.encode("utf-8") if isinstance(xml_bytes_str, str) else xml_bytes_str
            leido = leer_comprobante(xml_bytes)

            if es_emitidos:
                # -------------------------------------------------------------
                # FLUJO EMITIDOS (VENTAS)
                # -------------------------------------------------------------
                # 1. Validacion multi-tenant: el emisor DEBE ser la empresa
                if not identificacion_corresponde(leido.emisor_ruc, empresa.ruc):
                    fallidos.append({
                        "clave_acceso": clave,
                        "error": f"El comprobante fue emitido por {leido.emisor_ruc}, no por {empresa.razon_social} ({empresa.ruc})",
                        "reintentable": False,
                    })
                    continue

                # 2. Ingesta via ServicioImportacionEmitidas
                n_importadas, n_duplicadas, msgs, ids = ServicioImportacionEmitidas.importar(
                    db=db,
                    empresa=empresa,
                    contenido=xml_bytes,
                    nombre_archivo=f"{clave}.xml",
                    retornar_ids=True,
                )

                if n_importadas > 0:
                    guardados.append({
                        "clave_acceso": clave,
                        "numero": leido.clave_acceso,
                        "proveedor": leido.receptor_razon_social or "Consumidor Final",
                        "cod_doc": leido.cod_doc,
                        "total": float(leido.total),
                        "estado_sri": leido.estado or "AUTORIZADA",
                        "duplicado": False,
                    })
                elif n_duplicadas > 0:
                    guardados.append({
                        "clave_acceso": clave,
                        "numero": leido.clave_acceso,
                        "proveedor": leido.receptor_razon_social or "Consumidor Final",
                        "cod_doc": leido.cod_doc,
                        "total": float(leido.total),
                        "estado_sri": leido.estado or "AUTORIZADA",
                        "duplicado": True,
                    })
                else:
                    fallidos.append({
                        "clave_acceso": clave,
                        "error": msgs[0] if msgs else "No se pudo importar comprobante emitido",
                        "reintentable": False,
                    })
            else:
                # -------------------------------------------------------------
                # FLUJO RECIBIDOS (COMPRAS) - COMPORTAMIENTO EXISTENTE
                # -------------------------------------------------------------
                if not identificacion_corresponde(leido.receptor_identificacion, empresa.ruc):
                    fallidos.append({
                        "clave_acceso": clave,
                        "error": f"El comprobante fue emitido a {leido.receptor_identificacion}, no a {empresa.razon_social} ({empresa.ruc})",
                        "reintentable": False,
                    })
                    continue

                existente = db.execute(
                    select(FacturaRecibida).where(
                        FacturaRecibida.tenant_id == empresa.id,
                        FacturaRecibida.clave_acceso == clave,
                    )
                ).scalar_one_or_none()

                if existente:
                    guardados.append({
                        "clave_acceso": clave,
                        "numero": existente.clave_acceso,
                        "proveedor": existente.proveedor_nombre,
                        "cod_doc": existente.cod_doc,
                        "total": float(existente.total),
                        "estado_sri": existente.estado_sri,
                        "duplicado": True,
                    })
                    continue

                fecha_aut = leido.fecha_autorizacion
                if not fecha_aut and resp.get("fecha_autorizacion"):
                    fecha_aut = interpretar_fecha_hora(str(resp.get("fecha_autorizacion")))
                if not fecha_aut:
                    fecha_aut = ahora_utc()

                nueva = FacturaRecibida(
                    tenant_id=empresa.id,
                    proveedor_identificacion=leido.emisor_ruc,
                    proveedor_nombre=leido.emisor_razon_social or "Proveedor sin razon social",
                    clave_acceso=leido.clave_acceso,
                    cod_doc=leido.cod_doc,
                    version_xml=leido.version,
                    fecha_emision=leido.fecha_emision or ahora_utc(),
                    total=leido.total,
                    estado_sri=leido.estado or "AUTORIZADA",
                    numero_autorizacion=leido.numero_autorizacion or resp.get("numero_autorizacion") or clave,
                    fecha_autorizacion=fecha_aut,
                    ambiente=leido.ambiente or resp.get("ambiente") or item.ambiente or request.ambiente or 2,
                    verificado_en_sri=True,
                    fecha_verificacion_sri=ahora_utc(),
                    xml_documento=xml_bytes_str if isinstance(xml_bytes_str, str) else xml_bytes_str.decode("utf-8", errors="replace"),
                )
                db.add(nueva)
                try:
                    db.commit()
                    db.refresh(nueva)
                    guardados.append({
                        "clave_acceso": clave,
                        "numero": leido.clave_acceso,
                        "proveedor": nueva.proveedor_nombre,
                        "cod_doc": nueva.cod_doc,
                        "total": float(nueva.total),
                        "estado_sri": nueva.estado_sri,
                        "duplicado": False,
                    })
                except IntegrityError:
                    db.rollback()
                    existente = db.execute(
                        select(FacturaRecibida).where(
                            FacturaRecibida.tenant_id == empresa.id,
                            FacturaRecibida.clave_acceso == clave,
                        )
                    ).scalar_one_or_none()
                    guardados.append({
                        "clave_acceso": clave,
                        "numero": clave,
                        "proveedor": existente.proveedor_nombre if existente else (leido.emisor_razon_social or "Proveedor sin razon social"),
                        "cod_doc": existente.cod_doc if existente else leido.cod_doc,
                        "total": float(existente.total) if existente else float(leido.total),
                        "estado_sri": existente.estado_sri if existente else leido.estado,
                        "duplicado": True,
                    })

        except Exception as exc:
            db.rollback()
            logger.warning("Fallo al ingestar clave %s: %s", clave, exc)
            fallidos.append({
                "clave_acceso": clave,
                "error": str(exc),
                "reintentable": True,
            })

    return {
        "mensaje": f"{len(guardados)} procesados, {len(fallidos)} fallidos",
        "guardados": guardados,
        "fallidos": fallidos,
        "total_guardados": len(guardados),
        "total_fallidos": len(fallidos),
    }
```

---

## 3. Pruebas Unitarias para el Backend

En `api/tests/test_sincronizacion_extension.py`, anadir:
1. `test_pre_check_comprobantes_emitidos`: Verifica que al enviar `tipo_sincronizacion="EMITIDOS"`, consulte la tabla `Comprobante` y clasifique correctamente duplicadas y por sincronizar.
2. `test_ingestar_comprobante_emitido_valido`: Verifica que un XML de factura emitida donde `emisor_ruc == empresa.ruc` y `receptor = "9999999999999"` se procese exitosamente usando `ServicioImportacionEmitidas`.
3. `test_ingestar_comprobante_emitido_emisor_invalido`: Verifica que si el `emisor_ruc` no pertenece al tenant, se rechace adecuadamente.
