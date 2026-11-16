# Guía de Implementación para el Agente Backend (`facturador-ec/api`)

**Destinatario**: Agente de Inteligencia Artificial / Desarrollador Backend a cargo de `/Users/jona/emite/facturador-ec/api`  
**Objetivo**: Implementar los endpoints de la API necesarios para soportar la sincronización directa en 1 clic desde la extensión Chrome `sri-pro-downloader` (v3.3.0).  
**Contexto**: Los usuarios de EMITE.ec utilizan la extensión mientras consultan comprobantes en el portal del SRI en Línea. La extensión enviará solicitudes autenticadas vía `X-API-Key` para consultar duplicados e ingestar comprobantes recibidos de proveedores.

---

## 1. Resumen de Requerimientos Backend

Debes implementar **3 endpoints** en `app/api/endpoints/facturas_recibidas.py` (o en un nuevo router `app/api/endpoints/sincronizacion_extension.py` registrado en `app/api/api.py`):

1. `GET /api/v1/facturas-recibidas/sincronizar/verificar-conexion`: Comprueba que la API Key sea válida y retorna datos de la empresa tenant.
2. `POST /api/v1/facturas-recibidas/sincronizar/pre-check`: Compara un lote de claves contra la base de datos para identificar duplicadas, anuladas y nuevas.
3. `POST /api/v1/facturas-recibidas/sincronizar/ingestar-claves`: Ingesta un micro-lote de hasta 5 claves consultando el servicio SOAP del SRI y guardando en `FacturaRecibida`.
4. `POST /api/v1/facturas-recibidas/sincronizar/actualizar-anuladas`: Actualiza el estado a `ANULADA` de comprobantes reportados como anulados en el portal.

---

## 2. Autenticación y Dependencias

Utiliza la dependencia híbrida existente:
```python
from app.api import deps
# Dependencia de autenticación: soporta X-API-Key: <key> y Bearer JWT
# deps.get_current_tenant_or_api_key retorna la instancia del modelo Empresa (tenant actual)
```

---

## 3. Especificación Detallada de Endpoints

### Endpoint 0: `GET /api/v1/facturas-recibidas/sincronizar/verificar-conexion`

```python
@router.get("/sincronizar/verificar-conexion")
async def verificar_conexion_extension(
    empresa: Empresa = Depends(deps.get_current_tenant_or_api_key),
):
    """Verifica la validez de la API Key y retorna el tenant asociado."""
    return {
        "valido": True,
        "empresa_id": empresa.id,
        "ruc": empresa.ruc,
        "razon_social": empresa.razon_social,
        "ambiente_sri": empresa.ambiente_sri or 2,
    }
```

---

### Endpoint 1: `POST /api/v1/facturas-recibidas/sincronizar/pre-check`

**Propósito**: Evitar descargas o consultas redundantes filtrando comprobantes ya existentes en milisegundos.

**Esquemas Pydantic**:
```python
from pydantic import BaseModel, Field
from typing import List, Optional

class ItemComprobantePreCheck(BaseModel):
    clave_acceso: str = Field(..., min_length=49, max_length=49)
    cod_doc: str = Field(..., min_length=2, max_length=2)
    emisor_ruc: str
    emisor_nombre: Optional[str] = ""
    total: float
    fecha_emision: str
    estado_portal: Optional[str] = "AUTORIZADO"

class PreCheckRequest(BaseModel):
    comprobantes: List[ItemComprobantePreCheck]
```

**Implementación**:
```python
@router.post("/sincronizar/pre-check")
async def pre_check_comprobantes(
    request: PreCheckRequest,
    db: Session = Depends(deps.get_db),
    empresa: Empresa = Depends(deps.get_current_tenant_or_api_key),
):
    """Compara en base de datos las claves enviadas para clasificar duplicadas, anuladas y nuevas."""
    claves = [c.clave_acceso for c in request.comprobantes]
    if not claves:
        return {
            "total_analizados": 0,
            "duplicadas": [],
            "por_sincronizar": [],
            "anuladas_detectadas": [],
            "resumen": {"total": 0, "duplicadas_count": 0, "por_sincronizar_count": 0, "anuladas_count": 0}
        }

    # 1. Consultar facturas recibidas existentes de esta empresa
    existentes_db = db.execute(
        select(FacturaRecibida.clave_acceso, FacturaRecibida.estado_sri)
        .where(
            FacturaRecibida.tenant_id == empresa.id,
            FacturaRecibida.clave_acceso.in_(claves)
        )
    ).all()
    mapa_existentes = {row[0]: row[1] for row in existentes_db}

    # 2. Consultar comprobantes emitidos internamente hacia este RUC (ventas locales de otros tenants)
    internas_db = db.execute(
        select(Comprobante.clave_acceso)
        .join(Cliente, Comprobante.cliente_id == Cliente.id)
        .where(
            Cliente.identificacion == empresa.ruc,
            Comprobante.clave_acceso.in_(claves),
            Comprobante.estado == "AUTORIZADA"
        )
    ).scalars().all()
    set_internas = set(internas_db)

    duplicadas = []
    por_sincronizar = []
    anuladas_detectadas = []

    for c in request.comprobantes:
        clave = c.clave_acceso
        if clave in mapa_existentes:
            estado_actual = mapa_existentes[clave]
            # Si en DB estaba AUTORIZADA pero el portal SRI la reporta como ANULADO
            if c.estado_portal == "ANULADO" and estado_actual != "ANULADA":
                anuladas_detectadas.append({
                    "clave_acceso": clave,
                    "estado_anterior": estado_actual,
                    "estado_portal": "ANULADO"
                })
            else:
                duplicadas.append({
                    "clave_acceso": clave,
                    "origen": "facturas_recibidas",
                    "estado_actual": estado_actual
                })
        elif clave in set_internas:
            duplicadas.append({
                "clave_acceso": clave,
                "origen": "sistema_interno",
                "estado_actual": "AUTORIZADA"
            })
        else:
            por_sincronizar.append({
                "clave_acceso": clave,
                "cod_doc": c.cod_doc,
                "emisor_ruc": c.emisor_ruc,
                "total": c.total
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
            "anuladas_count": len(anuladas_detectadas)
        }
    }
```

---

### Endpoint 2: `POST /api/v1/facturas-recibidas/sincronizar/ingestar-claves`

**Propósito**: Recibe un micro-lote de hasta 5 claves, consulta el servicio SOAP del SRI (`ClienteSoapSRI`), parsea el XML con `leer_comprobante()` y lo inserta en `FacturaRecibida`.

**Reglas de Seguridad y Estabilidad**:
- Máximo 5 claves por petición para evitar timeouts de Nginx/Cloudflare.
- Validar `identificacion_corresponde(leido.receptor_identificacion, empresa.ruc)`.
- Si `cod_doc == '04'` (Nota de crédito), no anular la factura original; registrar la nota de crédito y asociar la referencia.
- NO marcar facturas como `ANULADA` si SOAP devuelve `numeroComprobantes == 0` (suele ser desfase de replicación del SRI).

**Esquemas Pydantic**:
```python
class IngestarClavesRequest(BaseModel):
    claves_acceso: List[str] = Field(..., max_items=5)
    ambiente: Optional[int] = 2
```

**Implementación**:
```python
from app.services.sri.cliente_soap import ClienteSoapSRI
from app.services.sri.lector_comprobante import leer_comprobante, identificacion_corresponde

@router.post("/sincronizar/ingestar-claves")
async def ingestar_claves_sri(
    request: IngestarClavesRequest,
    db: Session = Depends(deps.get_db),
    empresa: Empresa = Depends(deps.get_current_tenant_or_api_key),
):
    """Consulta al SRI e ingesta hasta 5 comprobantes por llamada."""
    if len(request.claves_acceso) > 5:
        raise HTTPException(
            status_code=422,
            detail="Por seguridad y tolerancia a timeouts, se permite un máximo de 5 claves por lote."
        )

    cliente = ClienteSoapSRI(ambiente=request.ambiente or empresa.ambiente_sri or 2)
    guardados = []
    fallidos = []

    for clave in request.claves_acceso:
        try:
            # 1. Consulta SOAP al SRI
            resp = cliente.autorizar_comprobante(clave)
            estado = (resp.get("estado") or "").strip().upper()
            xml_bytes_str = resp.get("xml_autorizado")

            if estado != "AUTORIZADO" or not xml_bytes_str:
                fallidos.append({
                    "clave_acceso": clave,
                    "error": f"El SRI reporta estado: {estado or 'SIN RESPUESTA'}",
                    "reintentable": True
                })
                continue

            # 2. Parseo del XML
            leido = leer_comprobante(xml_bytes_str.encode("utf-8") if isinstance(xml_bytes_str, str) else xml_bytes_str)

            # 3. Validación de Aislamiento Multi-Tenant (RUC receptor)
            if not identificacion_corresponde(leido.receptor_identificacion, empresa.ruc):
                fallidos.append({
                    "clave_acceso": clave,
                    "error": f"El comprobante fue emitido a {leido.receptor_identificacion}, no a {empresa.razon_social} ({empresa.ruc})",
                    "reintentable": False
                })
                continue

            # 4. Inserción idempotente
            existente = db.execute(
                select(FacturaRecibida).where(
                    FacturaRecibida.tenant_id == empresa.id,
                    FacturaRecibida.clave_acceso == clave
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
                    "duplicado": True
                })
                continue

            nueva = FacturaRecibida(
                tenant_id=empresa.id,
                proveedor_identificacion=leido.emisor_ruc,
                proveedor_nombre=leido.emisor_razon_social or "Proveedor sin razón social",
                clave_acceso=leido.clave_acceso,
                cod_doc=leido.cod_doc,
                version_xml=leido.version,
                fecha_emision=leido.fecha_emision,
                total=leido.total,
                estado_sri=leido.estado,
                numero_autorizacion=leido.numero_autorizacion,
                fecha_autorizacion=leido.fecha_autorizacion,
                ambiente=leido.ambiente,
                verificado_en_sri=True,
                fecha_verificacion_sri=ahora_utc(),
                xml_documento=xml_bytes_str if isinstance(xml_bytes_str, str) else xml_bytes_str.decode("utf-8", errors="replace"),
            )
            db.add(nueva)
            db.commit()
            db.refresh(nueva)

            guardados.append({
                "clave_acceso": clave,
                "numero": leido.clave_acceso,
                "proveedor": nueva.proveedor_nombre,
                "cod_doc": nueva.cod_doc,
                "total": float(nueva.total),
                "estado_sri": nueva.estado_sri,
                "duplicado": False
            })

        except Exception as exc:
            db.rollback()
            fallidos.append({
                "clave_acceso": clave,
                "error": str(exc),
                "reintentable": True
            })

    return {
        "mensaje": f"{len(guardados)} procesados, {len(fallidos)} fallidos",
        "guardados": guardados,
        "fallidos": fallidos,
        "total_guardados": len(guardados),
        "total_fallidos": len(fallidos)
    }
```

---

### Endpoint 3: `POST /api/v1/facturas-recibidas/sincronizar/actualizar-anuladas`

**Propósito**: Actualiza de forma segura el estado de comprobantes del tenant que fueron anulados en el SRI.

```python
class ActualizarAnuladasRequest(BaseModel):
    claves_acceso: List[str] = Field(..., max_items=50)
    motivo: Optional[str] = "Detectado como anulado en portal SRI vía extensión"

@router.post("/sincronizar/actualizar-anuladas")
async def actualizar_facturas_anuladas(
    request: ActualizarAnuladasRequest,
    db: Session = Depends(deps.get_db),
    empresa: Empresa = Depends(deps.get_current_tenant_or_api_key),
):
    """Actualiza a ANULADA los comprobantes indicados, asegurando aislamiento multi-tenant."""
    facturas = db.execute(
        select(FacturaRecibida).where(
            FacturaRecibida.tenant_id == empresa.id,
            FacturaRecibida.clave_acceso.in_(request.claves_acceso)
        )
    ).scalars().all()

    actualizadas = []
    for f in facturas:
        if f.estado_sri != "ANULADA":
            f.estado_sri = "ANULADA"
            actualizadas.append(f.clave_acceso)

    db.commit()

    return {
        "mensaje": f"Se actualizaron {len(actualizadas)} comprobantes a estado ANULADA",
        "total_actualizadas": len(actualizadas),
        "claves_actualizadas": actualizadas
    }
```

---

## 4. Pruebas y Validación Recomendadas

1. Ejecuta la suite de pruebas existente: `pytest tests/test_facturas_recibidas.py`.
2. Crea pruebas unitarias en `tests/test_sincronizacion_extension.py` verificando:
   - Autenticación con `X-API-Key`.
   - Pre-check identificando facturas ya existentes y nuevas.
   - Ingesta de chunk de 5 comprobantes con mock de `ClienteSoapSRI`.
   - Rechazo de facturas cuyo RUC receptor no pertenezca a la empresa (`403 Forbidden`).
