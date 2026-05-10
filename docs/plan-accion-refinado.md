# Plan de accion refinado - Prospeccion B2B Lexington

Este plan sustituye la arquitectura original basada en Outscraper, Supabase/n8n y Vapi directo por una arquitectura de SaaS propio: extraccion propia, PostgreSQL versionado en el repositorio, orquestacion interna con workers y llamadas mediante Nebrija AI.

## Cambios clave frente al documento original

1. PostgreSQL deja de ser Supabase/externo en el MVP. Se levanta desde `compose.yml` junto al resto de servicios y el esquema inicial vive en `infra/postgres/init/001-schema.sql`.
2. Outscraper sale del plan. La capa 1 pasa a ser un motor propio de captacion de fuentes permitidas: webs publicas de negocios, directorios con licencia compatible, open data y listas aportadas por el cliente. Google Maps/Places no debe ser la fuente primaria para crear una base de leads persistente.
3. n8n sale del plan. La orquestacion pasa al backend del SaaS mediante scheduler, cola Redis/BullMQ o equivalente, workers idempotentes y estados en PostgreSQL.
4. Vapi directo sale del dispatch. Las llamadas salientes se lanzan contra Nebrija AI (`POST https://nebrijaai.com/api/v1/calls`) y el webhook de fin de llamada se procesa con payload tipo Vapi `message.type = "end-of-call-report"`.

## Arquitectura propuesta

```text
SaaS Web/API
  -> Scheduler interno
  -> Cola Redis
  -> Workers:
       1. extraction-worker
       2. enrichment-worker
       3. scoring-worker
       4. outreach-worker
       5. voice-call-worker
       6. webhook-processor
  -> PostgreSQL
  -> Nebrija AI API
```

PostgreSQL es la fuente de verdad. Redis solo coordina ejecucion y reintentos; nada critico debe vivir solo en la cola.

## Compose e infraestructura base

El repositorio debe traer desde el dia uno:

- `compose.yml`: `postgres` y `redis`.
- `.env.example`: `DATABASE_URL`, `REDIS_URL`, `NEBRIJA_API_KEY`, `NEBRIJA_ASSISTANT_ID`, `NEBRIJA_PHONE_NUMBER_ID`, `NEBRIJA_WEBHOOK_SECRET`.
- `infra/postgres/init/001-schema.sql`: esquema inicial.
- Carpeta futura `apps/web` para el SaaS y `apps/worker` para jobs.

Comando esperado:

```bash
docker compose up -d
```

## Extraccion propia en lugar de Outscraper

La nueva capa de extraccion se implementa como servicio interno. Importante: "propio" no significa lanzar navegadores automatizados contra Google Maps, rotar proxies o saltar captchas. Eso es fragil, caro de mantener y entra en conflicto con las restricciones de Google Maps Platform sobre scraping y almacenamiento masivo de contenido.

La decision correcta para produccion es separar dos usos:

- Captacion de leads: fuentes permitidas y almacenables.
- Google Places: solo lookup/validacion puntual o experiencia de usuario con atribucion, no creacion de una base masiva de leads.

### Decision sobre Google Maps

Hay tres caminos posibles:

| Modo | Como funciona | Ventaja | Riesgo |
| --- | --- | --- | --- |
| A. Google Places API oficial | Nuestro backend llama a Text Search, Nearby Search y Place Details con API key | Estable, medible, sin captchas, coste claro | Los terminos estandar no permiten usar Places como base persistente de leads |
| B. Scraper propio de web abierta | Crawlers sobre webs de negocios, directorios permitidos, open data y listas del cliente | Datos almacenables si la fuente lo permite; control total | Menos cobertura inicial que Google Maps |
| C. Scraper DOM de Google Maps | Playwright contra `maps.google.com` leyendo tarjetas y fichas | Parece barato al principio | Alto riesgo: bloqueos, captchas, proxies, cambios de DOM y conflicto directo con terminos |

Recomendacion tecnica: si se insiste en Google, usar modo A, no modo C. Es decir, tener "scraper propio" como motor de orquestacion, dedupe, scoring y enrichment, pero usando la API oficial como conector de Google. El modo C no debe entrar en el MVP.

Componentes:

- `extraction_jobs`: nicho, ciudad, bbox, grid_step, estado y metricas.
- `source-planner`: selecciona fuentes por nicho y ciudad: open data, registros publicos, directorios permitidos, sitemaps, webs de asociaciones y listas del cliente.
- `web-discovery-worker`: descubre webs de negocios desde fuentes permitidas y respeta robots.txt, terminos y rate limits.
- `business-site-crawler`: extrae datos desde la web propia del negocio: nombre, telefono, emails, perfiles sociales, formularios, booking, chatbot y senales comerciales.
- `google-places-verifier` opcional: valida coincidencias puntuales o muestra datos en una UI con atribucion, sin usarlo para crear ni enriquecer una lista persistente de leads.
- `dedupe-service`: consolida por identificadores de fuente, dominio, telefono, email y hash estable de nombre + direccion + telefono.
- `raw_payload`: conserva el HTML/JSON normalizado para auditoria y re-procesado.

Politica operativa:

- Throttling estricto por dominio, fuente, ciudad y nicho.
- Backoff exponencial y reintentos con limite.
- Cache de descubrimiento segun lo permita cada fuente.
- Nada de proxy rotation, captcha bypass ni simulacion masiva de usuarios en navegador.
- Revision legal/ToS antes de escalar volumen.
- Google Places API solo se usa si el caso de uso cumple las condiciones de Google Maps Platform; no como extractor masivo de negocios.

### Como se captan leads en la practica

1. El usuario define campana: `nicho = clinica dental`, `ciudad = Madrid`, limite objetivo y criterios de scoring.
2. El `source-planner` carga fuentes permitidas para ese nicho: datos abiertos, registros sectoriales, colegios/asociaciones si sus terminos lo permiten, directorios licenciados y webs aportadas por el cliente.
3. El sistema descubre dominios y paginas semilla. Ejemplos:

```text
https://clinica-ejemplo.es/
https://asociacion-sectorial.example/socios/clinica-ejemplo
https://datos-abiertos.example/actividades-sanitarias.csv
```

4. El crawler visita la web propia del negocio, no Google Maps, y extrae:
   - telefonos y emails visibles o `mailto:`
   - redes sociales
   - formularios y paginas de contacto
   - senales de oportunidad: booking, chatbot, pixel, WhatsApp, calendario
5. Cada resultado se normaliza a `businesses` y `business_contacts`.
6. Se deduplica por dominio, telefono, email, identificador de fuente y hash de nombre + direccion.
7. Se guarda trazabilidad de la fuente y evidencia de donde salio cada dato.
8. Google Places, si se usa, queda limitado a validacion puntual o UI, y sus datos no se convierten en una lista de telemarketing.

Queda descartado para produccion el scraping DOM de `maps.google.com` con Playwright salvo como herramienta puntual de QA manual, porque no es una base solida ni juridicamente limpia para un SaaS.

### Crawler web: Firecrawl, self-host o adapter propio

La parte critica no debe ser un scraper casero monolitico. La implementaria detras de una interfaz propia, `CrawlerProvider`, para poder cambiar de motor sin tocar el pipeline:

```text
BusinessSiteCrawler
  -> CrawlerProvider
       -> firecrawl_cloud
       -> firecrawl_self_hosted
       -> crawlee_playwright_worker
       -> basic_http_parser
```

Recomendacion:

1. Para MVP rapido: usar Firecrawl Cloud como benchmark y fallback de calidad.
2. Para produccion con menos dependencia externa: self-host de Firecrawl o worker propio basado en Crawlee/Playwright.
3. Para paginas simples: `basic_http_parser` con HTTP + Readability/BeautifulSoup/Cheerio para ahorrar coste.
4. Para paginas JS-heavy o bloqueadas: Firecrawl o Crawlee/Playwright.

Firecrawl encaja especialmente bien para:

- `map`: descubrir URLs internas de una web.
- `scrape`: convertir paginas a markdown/html limpio.
- `crawl`: recorrer una web completa con limites.
- extraccion estructurada para paginas de contacto, servicios, equipo y reservas.

No lo usaria para:

- Google Maps.
- saltar captchas.
- rotar proxies contra sitios donde no tengamos permiso.
- ocultar la procedencia de datos.

El pipeline recomendado:

```text
website discovered
  -> map homepage
  -> select contact/about/services/booking URLs
  -> scrape selected URLs
  -> deterministic extractors: emails, phones, whatsapp, social links
  -> structured extractor: booking/chatbot/forms/signals
  -> store field-level provenance
  -> score lead
```

Reglas enterprise:

- timeout por pagina y por dominio
- limite de paginas por negocio
- cache de contenido normalizado
- robots.txt y terminos por fuente
- retry con backoff
- circuit breaker por dominio
- logs estructurados por `business_id`, `crawler_run_id`, `source_url`
- no persistir HTML bruto indefinidamente si contiene datos innecesarios

### Si aun asi queremos extraer desde Google Maps

Lo implementaria como `google_places_connector`, con una etiqueta clara de compliance/riesgo y sin mezclarlo con el crawler general:

1. `google_query_jobs`: nicho, ciudad, bbox, query, radio, estado, coste estimado.
2. Grid geoespacial por ciudad para evitar depender de una unica busqueda.
3. Query variants por nicho: `clinica dental`, `dentista`, `odontologia`, etc.
4. Text Search para busquedas semanticas y Nearby Search para celdas con lat/lng.
5. Place Details solo despues de deduplicar por `place_id`.
6. Field masks minimos para controlar coste.
7. Staging temporal de resultados Google con TTL corto.
8. Tabla final de leads con:
   - `place_id` de Google
   - datos propios extraidos de la web del negocio
   - datos del cliente o fuentes licenciadas
   - metadatos de scoring y outreach
9. Auditoria de procedencia por campo: `source = google_places`, `business_website`, `open_data`, `licensed_directory`, `manual_import`.
10. Boton de purga para borrar datos no permitidos si se decide no asumir el riesgo.

Pseudoflujo:

```text
campaign created
  -> build city grid
  -> enqueue google_query_jobs
  -> call Places Text/Nearby Search
  -> store temporary place_id candidates
  -> dedupe candidates
  -> optional Place Details with minimal fields
  -> crawl business website separately
  -> persist only data with allowed provenance
  -> score
  -> call/email workflow
```

No implementaria:

- rotacion de proxies para Google Maps
- resolucion de captchas
- cuentas falsas o simulacion de sesiones humanas
- scraping de reviews/fotos
- almacenamiento indefinido de contenido Google si no hay licencia

## Enriquecimiento propio

El enriquecimiento no depende de un proveedor externo:

- Rastreo controlado del sitio web del negocio.
- Extraccion de `mailto:`, emails visibles, redes sociales, formularios y paginas de contacto.
- Deteccion de senales: reservas online, chatbot, pixel, CRM forms, WhatsApp, calendario.
- Tabla `business_contacts` para emails, telefonos, perfiles sociales y confianza por fuente.

Regla: el enrichment-worker nunca bloquea el pipeline completo. Si una web falla, se marca con motivo y se continua.

## Orquestacion sin n8n

El flujo anterior de n8n se convierte en codigo del SaaS:

1. Scheduler crea `extraction_jobs`.
2. extraction-worker inserta/actualiza `businesses`.
3. enrichment-worker completa contactos y senales.
4. scoring-worker calcula `score`.
5. outreach-worker decide canal:
   - `score >= 70` y `phone_e164`: llamada.
   - `score 50-69`: llamada + email posterior.
   - `score < 50` con email: email.
   - sin contacto: enrichment adicional o descarte.
6. voice-call-worker llama a Nebrija AI.
7. webhook-processor ingiere eventos, actualiza `voice_calls` y mueve el lead de estado.

Cada worker debe ser idempotente. Las mutaciones importantes se guardan en PostgreSQL antes de llamar a APIs externas para evitar dobles llamadas.

## Integracion de llamadas con Nebrija AI

Endpoint de llamada saliente:

```http
POST https://nebrijaai.com/api/v1/calls
Authorization: Bearer <NEBRIJA_API_KEY>
Content-Type: application/json
```

Payload base:

```json
{
  "customer": {
    "number": "+34600111222"
  },
  "assistantId": "uuid-del-asistente",
  "phoneNumberId": "uuid-del-numero",
  "variables": {
    "business_id": "uuid-interno",
    "business_name": "Clinica Ejemplo",
    "city": "Madrid",
    "category": "clinica dental",
    "rating": 4.6,
    "review_count": 230
  }
}
```

Nebrija AI tambien permite lanzar contra `testId` para A/B tests. Eso encaja bien para probar prompts, voces o criterios de cualificacion sin tocar el pipeline.

## Webhooks y end-of-call-report formato Vapi

Nebrija AI permite registrar webhooks con eventos `call.started`, `call.finished` y `call.failed`, generando un secreto HMAC `whsec_...`. El endpoint recomendado del SaaS:

```text
POST /api/webhooks/nebrija/calls
```

Aunque el evento venga desde Nebrija, el parser debe tratar el cuerpo de fin de llamada como formato Vapi:

```json
{
  "message": {
    "type": "end-of-call-report",
    "endedReason": "hangup",
    "call": {
      "id": "call-id",
      "status": "ended"
    },
    "artifact": {
      "transcript": "AI: ... User: ...",
      "messages": []
    },
    "analysis": {
      "summary": "...",
      "structuredData": {
        "outcome": "interested",
        "has_current_provider": true,
        "best_callback_time": null,
        "notes": "..."
      }
    }
  }
}
```

Campos a persistir:

- `provider_call_id`: `message.call.id`.
- `ended_reason`: `message.endedReason` o `message.call.endedReason`.
- `transcript`: `message.artifact.transcript` o `message.transcript`.
- `summary`: `message.analysis.summary`.
- `structured_data`: `message.analysis.structuredData`.
- `recording_url`: `message.artifact.recording.url`, `message.recordingUrl` o equivalente.
- `raw_report`: payload completo para no perder campos futuros.

## Structured output recomendado

Crear en Nebrija AI un esquema `Free` para cualificacion B2B:

```json
{
  "name": "B2B Lead Qualification",
  "type": "Free",
  "description": "Extrae el resultado comercial de una llamada B2B.",
  "properties": [
    {
      "name": "outcome",
      "type": "string",
      "description": "Resultado final",
      "enum": ["interested", "not_interested", "callback", "no_answer", "wrong_number"]
    },
    {
      "name": "qualified",
      "type": "boolean",
      "description": "True si merece seguimiento humano"
    },
    {
      "name": "has_current_provider",
      "type": "boolean",
      "description": "Indica si ya trabaja con proveedor"
    },
    {
      "name": "best_callback_time",
      "type": "string",
      "description": "Fecha/hora preferida si pide rellamada"
    },
    {
      "name": "notes",
      "type": "string",
      "description": "Resumen accionable de 1-2 frases"
    }
  ]
}
```

## Roadmap de ejecucion

### Fase 0 - Base tecnica

- Anadir `compose.yml`, `.env.example` y esquema inicial.
- Elegir ORM/migraciones: Prisma, Drizzle o SQL directo versionado.
- Preparar healthchecks para Postgres y Redis.

### Fase 1 - Modelo de datos y estados

- Implementar tablas de leads, contactos, jobs, llamadas y webhooks.
- Definir transiciones de `lead_status`.
- Crear constraints para idempotencia: `place_id`, `provider_call_id`, `business_id + kind + value`.

### Fase 2 - Extraccion propia

- Implementar planner de grid por ciudad/nicho.
- Crear extraction-worker con limites de concurrencia.
- Guardar resultados normalizados y payload bruto.
- Dashboard interno para lanzar jobs y ver errores.

### Fase 3 - Enriquecimiento y scoring

- Worker de crawling de webs.
- Extraccion de emails, redes y senales de oportunidad.
- Scoring versionado para poder recalcular historico.

### Fase 4 - Orquestacion interna

- Sustituir grafo n8n por jobs de backend.
- Implementar retries, dead-letter queue y metricas.
- Garantizar que una llamada nunca se duplica por reintento.

### Fase 5 - Nebrija AI

- Crear asistente, numero y esquema structured output.
- Registrar webhook `call.started`, `call.finished`, `call.failed`.
- Implementar `voice-call-worker` con `POST /calls`.
- Implementar parser de `end-of-call-report` formato Vapi.

### Fase 6 - Compliance y operacion

- Lista de supresion: no llamar, no email, no contactar.
- Auditoria RGPD/LSSI y Registro Robinson antes de produccion.
- Consentimiento de grabacion si se almacenan recordings.
- Rate limits por cliente, nicho y ciudad.

## Criterio de MVP

El MVP esta completo cuando se puede:

1. Levantar `docker compose up -d` y tener Postgres + Redis sanos.
2. Crear un job de extraccion desde el SaaS.
3. Ver leads deduplicados en PostgreSQL.
4. Enriquecer y puntuar leads.
5. Lanzar una llamada Nebrija AI desde un lead.
6. Recibir `end-of-call-report` tipo Vapi.
7. Actualizar el estado del lead y guardar transcript, summary, outcome y raw payload.

## Implementacion inicial en el repo

Se ha dejado una primera version ejecutable con:

- `compose.yml`: API, worker, PostgreSQL y Redis.
- `apps/api`: API HTTP para crear campanas, importar negocios, lanzar crawls, scoring, llamadas y recibir webhooks.
- `apps/worker`: workers BullMQ para Google discovery, web discovery, business crawl, scoring y voice calls.
- `packages/core`: clientes Firecrawl, Google Places, Nebrija, parsers, extractores, scoring, colas y repositorios SQL.
- `infra/postgres/init/001-schema.sql`: esquema inicial con staging de Google, crawler runs, paginas crawleadas, provenance, leads y llamadas.
- `tests/core.test.mjs`: pruebas unitarias de normalizacion, extraccion, scoring, Firecrawl y Vapi report.

## Fuentes consultadas

- Nebrija AI docs: https://docs.nebrijaai.com/welcome
- Nebrija AI API index: https://docs.nebrijaai.com/llms.txt
- Nebrija AI outbound calls: https://docs.nebrijaai.com/api-reference/calls/lanzar-llamada-saliente
- Nebrija AI webhooks: https://docs.nebrijaai.com/api-reference/webhooks/crear-webhook
- Nebrija AI structured output: https://docs.nebrijaai.com/api-reference/structured-output/crear-esquema
- Vapi server events: https://docs.vapi.ai/server-url/events
