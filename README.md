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

## Clasificacion de funnel Ads con IA

El enriquecimiento de Ads limpia la landing con Firecrawl y genera un paquete
compacto de evidencias: texto visible, CTAs, formularios, links clave,
tecnologias detectadas y senales deterministas. Ese JSON se envia a DeepInfra
con DeepSeek V4 Flash para decidir si el trafico apunta a captacion de leads,
ecommerce u otro objetivo.

```env
DEEPINFRA_API_KEY=...
ADS_FUNNEL_AI_PROVIDER=deepinfra
ADS_FUNNEL_AI_MODEL=deepseek-ai/DeepSeek-V4-Flash
ADS_FUNNEL_AI_MODE=always
ADS_FUNNEL_AI_MAX_EVIDENCE_CHARS=18000
ADS_FUNNEL_AI_MAX_VISIBLE_TEXT_CHARS=9000
```

Si `DEEPINFRA_API_KEY` no esta configurada, el sistema mantiene el clasificador
determinista local como fallback para no bloquear el enriquecimiento.

## Flujo principal

1. `POST /campaigns` crea un job de descubrimiento.
2. `google-discovery` usa Google Places API con field mask minimo para candidatos.
3. `web-discovery` usa Firecrawl Search para encontrar la web oficial.
4. `business-crawl` usa Firecrawl Map/Scrape sobre la web del negocio.
5. `scoring` calcula prioridad.
6. `voice-call` lanza llamada Nebrija AI con el asistente elegido en la campana.
7. `POST /webhooks/nebrija/calls` ingiere `end-of-call-report` estilo Vapi.

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
- `TEST_JOBS_API_KEYS`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `FIRECRAWL_BASE_URL`
- `FIRECRAWL_API_KEY`
- `APIFY_API_KEY` opcional; fallback de bajo consumo para validar Meta Ads cuando la Ad Library bloquea Firecrawl
- `DEEPINFRA_API_KEY` para clasificar landings Ads con DeepSeek V4 Flash
- `GOOGLE_MAPS_API_KEY`
- `NEBRIJA_API_KEY`
- `NEBRIJA_ASSISTANT_ID`
- `NEBRIJA_PHONE_NUMBER_ID`
- `NEBRIJA_WEBHOOK_SECRET`

## API interna de test

Los endpoints `/api/test-jobs/*` requieren `x-api-key` o `Authorization: Bearer`.

Health interno:

```bash
curl http://localhost:3100/api/test-jobs/health \
  -H "x-api-key: $TEST_JOBS_API_KEY"
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
