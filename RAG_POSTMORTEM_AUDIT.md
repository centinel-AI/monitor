# RAG de postmortems + cadena notify→postmortem — Auditoría (solo lectura)

> Repo: `monitor` (Next.js 14, pg, pg-boss, pgvector). Objetivo: decidir cómo hacer configurables por proyecto
> dos toggles — (a) **RAG de postmortems**, (b) **postmortem automático**. **No se modificó código.** Fecha: 2026-06-24.

## TL;DR
- **No existe NADA de embeddings.** Ni cliente, ni modelo, ni env vars, ni escritura/lectura de vectores. La columna
  `incidents.embedding vector(1536)` está **100% muerta**.
- El "embedding" que verás en `postmortem.ts` es un **string de keywords** generado por el LLM del proyecto y solo
  **`console.log`-eado** (nunca persistido). No es RAG.
- El **postmortem** usa la **key BYOK del proyecto** (`project_settings.llm_api_key_encrypted`); sin key → `FallbackClient`
  (texto determinista, **no hay Azure global** en el código de monitor). Genera **sin contexto histórico** (solo eventos/deploys del propio incidente).
- La cadena pg-boss **termina en `notify`**; `postmortem` se encola **solo manualmente** (`POST /api/incidents/[id]/postmortem`, exige `status='resolved'`).
- **La pregunta clave (crédito de embeddings):** hoy NO hay credencial de embeddings de nadie. Y **Anthropic —el proveedor BYOK documentado— NO tiene API de embeddings**, así que el RAG **no puede reutilizar la BYOK Anthropic del cliente**: o es **coste tuyo** (Azure/OpenAI global) o se limita a proyectos con BYOK **OpenAI**.

---

## 1. EMBEDDINGS — ¿existe código que los genere?

**No.** Búsqueda exhaustiva (`embedding`, `text-embedding`, `embeddings.create`, `AZURE_OPENAI`, `createEmbedding`, `.embeddings`):

- **Cero clientes/SDK de embeddings.** No hay `openai.embeddings.create`, ni `text-embedding-3-*`, ni Azure OpenAI.
- **Cero env vars de embeddings.** `.env.example` no tiene `AZURE_OPENAI_*` ni nada de embeddings. Solo:
  - `MASTER_ENCRYPTION_KEY` (cifra las BYOK), y la nota *"ANTHROPIC_API_KEY is no longer used globally. Each project configures its [key]"*.
  - `SLACK_*`, `MONITOR_POSTGRES_URL`, `MONITOR_SERVICE_TOKEN`, etc. Ninguna de IA global.
- Lo único que se llama "embedding" — `src/agents/postmortem.ts:187-205` (`embeddingKeywords`): pide al **LLM del proyecto**
  (Claude/OpenAI BYOK) una lista de 10-15 términos clave; si es `fallback`, hace un regex de palabras. **No es un vector**;
  es texto, y solo se **loguea** (`postmortem.ts:214`, comentario *"pgvector migration pending"*).

**Credencial de embeddings hoy: NINGUNA.** No existe el concepto.

## 2. `incidents.embedding vector(1536)` — ¿se usa?

**Totalmente sin usar (columna muerta).**
- Declarada en `db/migrations/001_initial_schema.sql` (`embedding vector(1536)`), pgvector habilitado.
- **Escritura:** ninguna. `grep` de `UPDATE … embedding` / `INSERT … embedding` → 0. El único `UPDATE incidents` del postmortem
  escribe `postmortem` + `postmortem_generated_at`, **no** `embedding` (`postmortem.ts:207-210`).
- **Lectura/similitud:** ninguna. `grep` de `<=>`, `<->`, `cosine`, `similarity`, `ORDER BY embedding` → 0.
- En `src/types/database.ts` aparece como `number[] | null` (tipo), nada más.

## 3. POSTMORTEM — generador actual

- **Código:** `src/agents/postmortem.ts` → `generatePostmortem(incidentId, projectId)`. Worker pg-boss `runPostmortem`.
- **Credencial:** **BYOK del proyecto.** Usa `getLLMClient(projectId)` (`src/lib/llm/factory.ts`): lee
  `project_settings.llm_provider` + `llm_api_key_encrypted`, **descifra** (`decryptSecret`) y crea `AnthropicClient`/`OpenAIClient`.
  Sin provider/key → **`FallbackClient`** (`complete()` devuelve texto vacío → `FALLBACK_POSTMORTEM` determinista).
  Modelo por defecto: `claude-haiku-4-5-20251001` (anthropic) / `gpt-4o-mini` (openai) (`src/lib/llm/defaults.ts`).
  ⚠️ **No hay Azure OpenAI global** en monitor: "sin BYOK" = fallback vacío, NO un modelo del sistema. (La pantalla del
  portal que dice "Azure (default)" no está respaldada por credencial en el código de monitor — discrepancia a anotar.)
- **¿Usa RAG/embedding para el prompt?** **No.** El contexto se construye SOLO con datos del **propio incidente**:
  `alert_events` + `deploys` en una ventana de 2h antes del `started_at` hasta `resolved_at`, + el `alert_groups.score_reason`
  (`postmortem.ts` pasos 2-6). **No consulta incidentes pasados similares** ni embeddings. Genera blameless markdown sin memoria histórica.
- Persistencia: `UPDATE incidents SET postmortem=…, postmortem_generated_at=now()`. Fallo → `postmortem_failed_at`/`postmortem_error` (no relanza; pg-boss reintenta).

## 4. CADENA pg-boss notify→postmortem

Colas (`src/lib/queue/boss.ts`): `monitor.dedup → monitor.score → monitor.correlate → monitor.notify` · `monitor.postmortem` (aislada).

- **Termina en `notify`.** `correlator.ts:360` hace `boss.send(QUEUE.NOTIFY, …)` (si `finalScore > 70`). El **notifier NO encola postmortem** (`grep QUEUE.POSTMORTEM|boss.send` en `notifier.ts` → 0).
- **`postmortem` se encola SOLO manualmente:** `POST /api/incidents/[id]/postmortem` (`route.ts:72` `boss.send(QUEUE.POSTMORTEM, …)`), con guardas:
  - exige `incident.status === 'resolved'` → si no, `400 "Incident must be resolved first"`.
  - si ya hay `postmortem`, lo devuelve cacheado (no re-encola).
- **¿Qué dispararía uno automático?** El **cambio de status a `resolved`**: `PATCH /api/incidents/[id]` (`route.ts:129+`)
  es donde se setea `status='resolved'` (+ `resolved_at`). Es la transición natural para auto-encolar postmortem.
  (notify ocurre ANTES de resolver — un incidente recién notificado sigue `open`; generar postmortem al notificar sería prematuro.)

## 5. project_settings — esquema y patrón de lectura

Esquema efectivo (de `001` + migraciones M.2.d/g + Slack):
```
project_id              uuid PRIMARY KEY → projects(id) ON DELETE CASCADE
llm_provider            text NULL CHECK (openai|anthropic)
llm_api_key_encrypted   bytea NULL          -- BYOK cifrada (AES-256-GCM)
llm_model               text NULL
llm_api_key_updated_at  timestamptz NULL
slack_bot_token_encrypted bytea NULL        -- (fix connector Slack)
slack_channel           text NULL
created_at, updated_at  timestamptz
```
**Patrón de acceso en el pipeline** (lectura directa, sin caché):
- LLM: `getLLMClient(projectId)` (`factory.ts`) → `SELECT llm_provider, llm_api_key_encrypted, llm_model FROM project_settings WHERE project_id=$1`.
- Settings/estado: `getProjectSettings` (`queries.ts`) — nunca devuelve la key.
- Slack: `getProjectSlackConfig`/`getProjectSlackStatus`/`setProjectSlackConfig` (`queries.ts`).
- Los toggles nuevos (`rag_enabled boolean`, `auto_postmortem boolean`) encajan como **dos columnas más** aquí, leídas por el worker postmortem y por el trigger de resolve.

---

## 6. VEREDICTO por toggle

### (a) RAG de postmortems — qué hay y qué falta
**Existe:** pgvector habilitado + columna `incidents.embedding vector(1536)` (vacía); un paso de "keywords" (texto, no vector); el postmortem ya arma un contexto estructurado al que se podría inyectar memoria.
**Falta (todo lo sustantivo):**
1. **Cliente de embeddings** (no existe ninguno) + decidir modelo/dimensión (la columna es 1536 → encaja `text-embedding-3-small`/`ada-002`).
2. **Generar y ESCRIBIR el embedding** al resolver/generar (hoy `embedding` nunca se escribe).
3. **Consulta de similitud** (`ORDER BY embedding <=> $query LIMIT k`, con filtro `project_id` para aislar por tenant) — no existe.
4. **Inyección en el prompt** del postmortem de los incidentes pasados similares — hoy el prompt no tiene memoria histórica.
5. Toggle `rag_enabled` en `project_settings` + lectura en el worker.
→ **El RAG está a nivel 0**: solo la columna y la extensión. Es construir el pipeline de embeddings entero.

### (b) Postmortem automático — qué hay y qué falta
**Existe:** cola `monitor.postmortem` + worker `runPostmortem` ya funcionando (reutilizable tal cual); la transición a `resolved` está localizada (`PATCH /api/incidents/[id]`).
**Falta:**
1. **El trigger**: encolar `boss.send(QUEUE.POSTMORTEM, …)` al pasar a `resolved` (en el PATCH) — hoy solo lo hace la ruta manual.
2. Toggle `auto_postmortem` en `project_settings` + comprobarlo antes de encolar (y respetar el short-circuit "ya generado").
3. (Opcional) idempotencia/anti-doble-encolado si PATCH se llama varias veces.
→ **Bajo esfuerzo**: la maquinaria (cola+worker) ya existe; es un toggle + un `boss.send` condicional en el sitio del resolve. **No** hace falta cola nueva.

### ⭐ La pregunta clave: ¿de quién es la credencial de embeddings?
**Hoy: de nadie (no hay embeddings).** Y al diseñarlo choca un hecho decisivo:
- **Anthropic NO ofrece API de embeddings.** El BYOK documentado es `openai|anthropic`, pero la mayoría de proyectos usarán Anthropic (Claude) → **su BYOK NO sirve para embeddings**.
- Por tanto el RAG **no puede ser "coste-cliente" reutilizando su BYOK** salvo que el proyecto use **OpenAI** BYOK (entonces sí, su `text-embedding-3-*` con su key = coste cliente).
- Las opciones reales:
  1. **Credencial de embeddings GLOBAL tuya** (Azure OpenAI / OpenAI propio) → **coste TUYO**, RAG disponible para todos los proyectos por igual. Requiere nuevas env vars (`AZURE_OPENAI_*` o `OPENAI_EMBEDDINGS_KEY`) — hoy inexistentes.
  2. **Solo coste-cliente**: habilitar RAG **únicamente** en proyectos con BYOK OpenAI (usar su key para embeddings). Los proyectos Anthropic no tendrían RAG (o caerían a la global).
  3. Híbrido: usa OpenAI-BYOK si está; si no, la global tuya (si existe).
- **Recomendación de decisión** (no implementada): definir esto ANTES de tocar nada, porque cambia el modelo de coste y las env vars. El LLMClient actual (`complete` only) **no tiene método `embed`** → habría que extender la abstracción o añadir un cliente de embeddings separado, casi seguro **global**.

---

## Notas / deuda detectada (no tocada)
- `incidents.embedding` muerta + keywords solo logueadas → el código sugiere un RAG "a medio empezar" que nunca se cableó.
- **No hay Azure/LLM global** en monitor pese a que el portal muestra "Azure (default)": sin BYOK, postmortem/correlator/notifier caen a `FallbackClient` (texto vacío/determinista). Confirmar si "Azure default" debe existir de verdad (sería otra credencial global tuya).
- `postmortem.ts` comment "stores the markdown and keyword embedding in the database" es **engañoso**: el keyword embedding NO se guarda.
