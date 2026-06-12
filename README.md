# Lexington Prospecting SaaS

Sistema de prospeccion B2B con PostgreSQL, Redis, workers internos, Firecrawl self-hosted y llamadas con Nebrija AI.

## Arranque local

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f compose.local.yml up -d
```

Servicios:

- API: `http://localhost:3100`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

En Dokploy se usa `docker-compose.yml` directamente. La API publica por defecto el
puerto host `3100`, mientras que PostgreSQL y Redis quedan solo dentro de la red
del compose.

La interfaz usa solo login con Google. Configura en Google Cloud un OAuth Client
tipo Web y anade como redirect URI:

```text
${PUBLIC_BASE_URL}/auth/google/callback
```

Variables:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
SESSION_COOKIE_NAME=lex_session
SESSION_TTL_DAYS=14
```

El acceso se limita a cuentas Google con email verificado. Las restricciones de
tenant deben resolverse con invitaciones o roles, no bloqueando el callback OAuth.

## Firecrawl self-hosted

Este repo asume Firecrawl desplegado fuera del compose, por ejemplo en Dokploy.

Configura:

```env
FIRECRAWL_BASE_URL=https://tu-firecrawl.example.com/v2
FIRECRAWL_API_KEY=fc_xxx
CRAWLER_PROVIDER=firecrawl
```

Si tu despliegue expone Firecrawl sin `/v2`, cambia `FIRECRAWL_BASE_URL` al path real que acepte `/map`, `/scrape` y `/search`.

## Actividad Ads con IA

El enriquecimiento de Ads primero pide a DeepSeek V4 Flash un plan de
descubrimiento: queries de Firecrawl, probes de Meta Ads Library y URLs oficiales
de Google Ads Transparency Center que debe inspeccionar para ese negocio. Ese
plan dirige la recogida de evidencia. En modo productivo estricto, si DeepSeek no
devuelve un plan valido, no se inspeccionan Meta/Google Ads Library y el resultado
queda como `unknown`.

Firecrawl ejecuta ese plan y, opcionalmente, Apify solo aporta evidencia: URLs
consultadas, snippets, IDs, dominios, landings y matches posibles. La decision
final `active=true/false/null` siempre la toma DeepSeek V4 Flash en DeepInfra con
un paquete de evidencia cerrado. Para aceptar `active=true` o `active=false`, la
respuesta de DeepSeek debe apuntar a evidencia existente por `selectedAttemptIds`
o `sourceUrl`, y debe incluir `active` + `status` coherentes; una conclusion sin
respaldo trazable o con campos incompletos queda como `unknown`. En produccion,
esa evidencia tambien debe venir de una fuente `plannedBy=ai` del plan DeepSeek;
si solo viene de semillas locales, queda como `unknown`. Si no hay IA
configurada, el sistema no verifica anuncios por heuristica y devuelve `unknown`.

Por defecto, cada decision booleana de Ads pasa por una segunda llamada de
auditoria DeepSeek (`ADS_ACTIVITY_AI_VERIFY_MODE=always`). Esa auditoria solo
puede confirmar o invalidar la decision propuesta; si discrepa, falla o necesita
mas evidencia, el proveedor queda como `unknown` y no se escribe `true/false` en
las columnas operativas.

Las columnas operativas `ads_meta_active` y `ads_google_active` solo se escriben
con `true/false` cuando el proveedor tiene `ai.status=resolved` y
`ai.verification.status=confirmed`; cualquier resultado sin IA resuelta y
auditada se persiste como `null`. El JSON `ads_enrichment` tambien se sanitiza:
si llega un booleano no auditado, se convierte a `unknown` antes de guardarse.

```env
DEEPINFRA_API_KEY=...
ADS_ACTIVITY_AI_MODEL=deepseek-ai/DeepSeek-V4-Flash
ADS_ACTIVITY_AI_MODE=always
ADS_ACTIVITY_AI_VERIFY_MODE=always
ADS_ACTIVITY_AI_REQUIRE_PLANNED_EVIDENCE=true
ADS_ACTIVITY_AI_MAX_EVIDENCE_CHARS=22000
ADS_ACTIVITY_AI_REQUEST_TIMEOUT_MS=45000
ADS_APIFY_FALLBACK_MODE=off
```

`ADS_APIFY_FALLBACK_MODE` admite:

- `off`: no usa Apify aunque exista `APIFY_API_KEY`.
- `on_unknown`: usa Apify solo si DeepSeek queda en `unknown` con Firecrawl.
- `always`: recoge evidencia Apify siempre, pero DeepSeek sigue decidiendo.

Cuando Apify esta habilitado, Meta usa primero las fuentes `plannedBy=ai` del
plan de descubrimiento DeepSeek. Por defecto no usa semillas locales como
fallback de pago: una empresa hace como maximo una llamada Meta Apify
(`ADS_APIFY_META_MAX_SOURCES=1`) y pide un solo resultado
(`APIFY_MAX_CHARGED_RESULTS=1`) con `scrapeAdDetails=false`. Si el plan de
descubrimiento DeepSeek falla o no propone una fuente Meta precisa, Apify no se
ejecuta aunque `ADS_APIFY_FALLBACK_MODE=always`. El fallback Apify para Google
queda apagado por defecto (`ADS_APIFY_GOOGLE_FALLBACK_ENABLED=false`) porque
Firecrawl ya cubre la comprobacion por dominio de Google Ads Transparency.

Las respuestas IA guardan `usage` y `cost` estimado con precios DeepSeek V4
Flash: $0.10/M tokens de entrada, $0.20/M tokens de salida y $0.02/M tokens de
entrada cacheada. Esto queda en `discoveryPlan.ai.cost`, `meta.ai.cost`,
`meta.ai.verification.cost`, `google.ai.cost`, `google.ai.verification.cost`,
`classification.ai.cost`, `decision_maker.searchPlan.ai.cost` y
`decision_maker.ai.cost`/`decision_maker.ai.verification.cost` cuando el
proveedor devuelve usage.

## Clasificacion de funnel Ads con IA

Despues de verificar actividad Ads, el sistema limpia la landing con Firecrawl y
genera otro paquete compacto de evidencias: texto visible, CTAs, formularios,
links clave, tecnologias detectadas y senales deterministas. Ese JSON se envia a
DeepInfra con DeepSeek V4 Flash para decidir si el trafico apunta a captacion de
leads, ecommerce u otro objetivo.

```env
ADS_FUNNEL_AI_MODEL=deepseek-ai/DeepSeek-V4-Flash
ADS_FUNNEL_AI_MODE=always
ADS_FUNNEL_AI_MAX_EVIDENCE_CHARS=18000
ADS_FUNNEL_AI_MAX_VISIBLE_TEXT_CHARS=9000
```

Si `DEEPINFRA_API_KEY` no esta configurada, falla la llamada o la respuesta no es
valida, la clasificacion de funnel queda en `unknown` con `ai.status` auditado.
Las senales deterministas se conservan solo como evidencia enviada a DeepSeek;
no deciden el resultado final.

## Enriquecimiento de decisor con LinkedIn

Tras crear leads desde Google Places, el worker encola `decision-maker-enrichment`.
DeepSeek V4 Flash planifica primero las queries que Firecrawl debe lanzar contra
Google/LinkedIn, usando nombre, marca limpia, ciudad, nicho, web y contactos ya
extraidos. La semilla sigue incluyendo un Google dork quirurgico contra perfiles
personales de LinkedIn:

```text
site:linkedin.com/in/ "Nombre Comercial" "Ciudad"
```

La ciudad mejora la precision, pero ya no bloquea el enriquecimiento: si falta,
el sistema busca por marca/nombre sin generar queries vacias y la decision final
sigue quedando en DeepSeek.

El modulo limpia sufijos societarios comunes (`S.L.`, `S.A.`, etc.) y tambien
recorta descriptores largos tipo `Empresa de...` para buscar primero la marca
comercial. DeepSeek planifica las queries; Firecrawl las ejecuta contra perfiles
personales `/in/`, paginas de empresa `/company/` y, cuando aparecen candidatos,
queries adicionales por persona. Cada resultado conserva `plannedBy` y
`discoveryReason`. El resultado se guarda en `custom_fields.decision_maker`.

El enriquecimiento separa tres niveles operativos:

- `verified`: persona decisora con perfil personal, empresa y rol suficientemente claros.
- `candidate`: persona relacionada, pero con evidencia insuficiente para tratarla como decisor.
- `access_contact`: sin persona verificable; se recomienda el mejor telefono/email/social/LinkedIn empresa disponible.

DeepSeek V4 Flash en DeepInfra resuelve siempre con un paquete de evidencia
cerrado: plan de busqueda, queries, resultados brutos de busqueda, titulos,
snippets, candidatos, LinkedIn empresa y contactos ya extraidos. No debe
inventar datos. Si la IA no esta configurada, el sistema no marca un decisor
como `verified`; deja el caso como contacto de acceso o no encontrado con
`ai_required_but_unavailable`. La respuesta debe incluir `found` y
`decisionStatus` explicitamente; si faltan o se contradicen, se trata como
respuesta invalida.

Cuando la resolucion propone `found=true`, otra llamada DeepSeek de auditoria
revisa la decision (`DECISION_MAKER_AI_VERIFY_MODE=always`). Solo conserva
`verified` si confirma que la URL es un perfil personal `/in/` y que titulo o
snippet conectan a la persona con el negocio y un rol decisor. Ademas, en
produccion el resultado seleccionado debe venir de una query `plannedBy=ai`; si
sale solo de una query semilla local, queda como `candidate`. Si rechaza, queda
como `candidate`/`access_contact` y no se guarda como decisor verificado.
El worker solo crea contactos operativos `linkedin_decision_maker`,
`decision_maker_name` y `decision_maker_role` si esa auditoria esta confirmada.
La entrada `custom_fields.decision_maker` tambien se sanitiza antes de guardar:
un `found=true` no auditado pasa a `candidate` con el perfil original solo como
`unverifiedDecisionMaker`.

```env
DEEPINFRA_API_KEY=...
DECISION_MAKER_AI_MODEL=deepseek-ai/DeepSeek-V4-Flash
DECISION_MAKER_AI_MODE=always
DECISION_MAKER_AI_VERIFY_MODE=always
DECISION_MAKER_AI_REQUIRE_PLANNED_SEARCH=true
DECISION_MAKER_AI_MAX_EVIDENCE_CHARS=12000
```

Smoke real con expectativas:

```bash
npm run smoke:enrichment -- --cases ./smoke-cases.json
```

Formato minimo:

```json
[
  {
    "name": "Clinica Demo",
    "city": "Madrid",
    "website": "https://example.com",
    "expectedAds": {
      "metaActive": true,
      "googleActive": false,
      "funnelType": "lead_generation",
      "maxApifyCalls": 0
    },
    "maxDeepseekUsd": 0.02,
    "expectedDecisionMaker": {
      "found": true,
      "linkedinUrl": "https://www.linkedin.com/in/persona-demo",
      "fullName": "Persona Demo"
    }
  }
]
```

El smoke falla si faltan expectativas, si Meta/Google no coinciden, si DeepSeek
queda sin resolver, si el funnel esperado no coincide o si el perfil esperado
del decisor no coincide. Tambien falla si Apify se usa con
`ADS_APIFY_FALLBACK_MODE=off` o si supera `maxApifyCalls`,
`maxMetaApifyCalls` o `maxGoogleApifyCalls`. Tambien puede fallar por
presupuesto DeepSeek con `maxDeepseekUsd`. `city` mejora la prueba, pero no es
obligatoria.

Job real de 100 empresas de reformas en Madrid:

```bash
npm run job:reformas-madrid -- --limit 100 --max-deepseek-usd 5
```

Este runner no depende de API/worker/Redis: descubre empresas con Google Places,
ejecuta Ads + decisor directamente con Firecrawl y DeepSeek, y escribe un informe
JSON en `reports/`. Falla si Meta o Google no quedan resueltos por IA con un
booleano, si el funnel de anuncios activos no lo clasifica DeepSeek, si el
decisor no queda resuelto por IA, si Apify se usa estando desactivado o si se
supera el presupuesto DeepSeek. Antes de declarar PASS tambien valida que el
informe tenga exactamente 100 filas unicas de reformas en Madrid, sin duplicados,
con auditoria DeepSeek confirmada en Ads y decisor, y con resumen de coste
DeepSeek. Usa `--require-decision-maker` para exigir que los 100 tengan perfil
personal de LinkedIn verificado.

Revalidar un informe ya generado sin gastar nuevas llamadas:

```bash
npm run report:validate-enrichment -- \
  --report reports/reformas-madrid-enrichment.json \
  --expected-limit 100 \
  --max-deepseek-usd 5
```

Este comando falla si el JSON contiene fallos embebidos, filas incompletas,
duplicados, Ads/decisor sin auditoria confirmada, Apify usado en modo `off` o
coste DeepSeek por encima del presupuesto.

## Flujo principal

1. `POST /campaigns` crea un job de descubrimiento.
2. `google-discovery` usa Google Places API con field mask minimo para candidatos.
3. `decision-maker-enrichment` busca el perfil personal de LinkedIn del decisor.
4. `web-discovery` usa Firecrawl Search para encontrar la web oficial.
5. `business-crawl` usa Firecrawl Map/Scrape sobre la web del negocio.
6. `scoring` calcula prioridad.
7. `voice-call` lanza llamada Nebrija AI con el asistente elegido en la campana.
8. `POST /webhooks/nebrija/calls` ingiere `end-of-call-report` estilo Vapi.

La API key de NebrijaAI puede configurarse por tenant desde `Settings`. Si no hay
configuracion guardada en base de datos, el sistema usa las variables de entorno
como fallback. Cada campana puede vincular un asistente listado desde
`GET /assistants` usando esa API key. Las variables detectadas en el asistente se
rellenan con campos del lead (`business_name`, `city`, `phone_e164`, `score`,
etc.) al lanzar la llamada.

## Endpoints utiles

Los endpoints funcionales usan la sesion del navegador. Para automatizacion sin
sesion de Google, usa `/api/test-jobs/*` con `TEST_JOBS_API_KEYS`.

Crear campana:

```bash
curl -X POST http://localhost:3100/campaigns \
  -H 'content-type: application/json' \
  -d '{"niche":"clinica dental","city":"Madrid","sourceType":"google_places_api","requestedLimit":1000}'
```

Importar negocio manual:

```bash
curl -X POST http://localhost:3100/businesses \
  -H 'content-type: application/json' \
  -d '{"name":"Clinica Demo","website":"https://example.com","city":"Madrid","niche":"clinica dental"}'
```

Lanzar crawl:

```bash
curl -X POST http://localhost:3100/businesses/<business-id>/crawl \
  -H 'content-type: application/json' \
  -d '{}'
```

Lanzar llamada:

```bash
curl -X POST http://localhost:3100/businesses/<business-id>/call \
  -H 'content-type: application/json' \
  -d '{}'
```

## Variables criticas

- `DATABASE_URL`
- `REDIS_URL`
- `TEST_JOBS_API_KEYS` o `TEST_JOBS_API_KEY_SHA256S` para proteger `/api/test-jobs/*`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `FIRECRAWL_BASE_URL`
- `FIRECRAWL_API_KEY`
- `APIFY_API_KEY` opcional; solo se usa si `ADS_APIFY_FALLBACK_MODE` no es `off`
- `ADS_APIFY_FALLBACK_MODE` para controlar gasto Apify: `off`, `on_unknown` o `always`
- `APIFY_FACEBOOK_ADS_ACTOR_ID`, por defecto `curious_coder~facebook-ads-library-scraper`
- `APIFY_MAX_CHARGED_RESULTS`, por defecto `1`
- `ADS_APIFY_META_MAX_SOURCES`, por defecto `1`
- `ADS_APIFY_GOOGLE_FALLBACK_ENABLED`, por defecto `false`
- `DEEPINFRA_API_KEY` para resolver actividad Ads, landings Ads y decisor con DeepSeek V4 Flash
- `GOOGLE_MAPS_API_KEY`
- `NEBRIJA_API_KEY`
- `NEBRIJA_ASSISTANT_ID`
- `NEBRIJA_PHONE_NUMBER_ID`
- `NEBRIJA_WEBHOOK_SECRET`

## API interna de test

Los endpoints `/api/test-jobs/*` requieren `x-api-key` o `Authorization: Bearer`.
Puedes configurar `TEST_JOBS_API_KEYS` con claves en claro, o `TEST_JOBS_API_KEY_SHA256S`
con hashes SHA-256 separados por coma para no persistir la clave:

```bash
printf '%s' "$TEST_JOBS_API_KEY" | shasum -a 256
```

Health interno:

```bash
curl http://localhost:3100/api/test-jobs/health \
  -H "x-api-key: $TEST_JOBS_API_KEY"
```

Lanzar el batch real de 100 empresas de reformas en Madrid desde el entorno
desplegado, usando las API keys configuradas ahi:

```bash
curl -X POST http://localhost:3100/api/test-jobs \
  -H "content-type: application/json" \
  -H "x-api-key: $TEST_JOBS_API_KEY" \
  -d '{"type":"reformas_madrid_enrichment","limit":100,"maxDeepseekUsd":5}'
```

Lanzar crawl real con Firecrawl:

```bash
curl -X POST http://localhost:3100/api/test-jobs \
  -H "content-type: application/json" \
  -H "x-api-key: $TEST_JOBS_API_KEY" \
  -d '{"type":"business_crawl","website":"https://example.com"}'
```

## Tests

```bash
npm install
npm test
```
