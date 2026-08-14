# ClearPath Assessment 360

Assessment 360 online para Speak Easy: **Welcome → Intake → English Level → (STEPS 2 *o* OET Skills, según el resultado) → Speaking Assessment (en vivo)**, con desbloqueo adaptativo por nivel y audios de reproducción limitada (imitando el formato OET).

## Estado actual

Lo que ya funciona:

- **Login** (`index.html` + Edge Function `login`): valida solo el código de acceso contra la tabla `students` precargada por Diana en Supabase. Nombre completo y correo se piden en la misma pantalla, pero son informativos/estéticos (solo se usan para personalizar el saludo en `welcome.html`, no se comparan contra lo precargado). Emite un `session_token` de 4 horas que el frontend usa en el resto de las llamadas en vez del código de acceso.
- **Welcome page** (`welcome.html`): pantalla informativa entre el login y el intake, con el objetivo del assessment, cómo está organizado, duración estimada, reglas del examen, recomendaciones antes de empezar y un pedido explícito de honestidad académica (sin traductores, sin IA, sin ayuda de terceros).
- **Intake** (`intake.html`): formulario previo no calificado (nivel autopercibido, experiencia previa, frecuencia de uso del idioma) para dar contexto sobre el estudiante.
- **Reanudar un módulo a mitad de camino** (`get-module-progress`, agregado 10/08/2026): si el estudiante recarga la página o pierde la conexión a mitad de un módulo de opción múltiple, el frontend pregunta qué preguntas ya tienen respuesta guardada y salta directo a la primera sin responder, en vez de reiniciar desde la pregunta 1.
- **Nivel 1 — English Level** (~1 hora en total): las 4 destrezas completas.
  - Grammar: 20 preguntas (`data/nivel1-grammar.json`), timer de 10 minutos, cálculo de nivel CEFR por "ceiling".
  - Listening: 5 audios (uno por banda A1-C1), 20 preguntas de opción múltiple, una sola reproducción por audio con URL firmada (sin timer explícito, pensado para ~10-11 minutos). Revisión pedagógica completa aplicada el 12/08/2026 (ver Brief, sección 5).
  - Reading: timer de 20 minutos. Revisión pedagógica completa aplicada el 11/08/2026.
  - Writing: 1 tarea (email, 120-180 palabras), timer de 20 minutos, calificación por IA con rúbrica de placement 0-10 combinada con CEFR.
- **Lógica de desbloqueo** (`js/scoring.js`): la decisión se toma recién cuando existen los 4 sub-scores de Nivel 1 (grammar, listening, writing, reading), y son **tres rutas mutuamente excluyentes** (nunca se combinan STEPS 2 y OET):
  - Si los 4 llegan a B2 → ruta **OET** → módulo OET Skills → Speaking Assessment tipo OET.
  - Si no, pero reading solo llega a B2 → ruta **STEPS 2** → Speaking Assessment tipo English.
  - Si reading tampoco llega → ruta **English** → Speaking Assessment tipo English directo, sin STEPS 2 ni OET.
  
  El router `siguiente.html` le pregunta a la Edge Function `get-unlock-state` a qué pantalla mandar al estudiante después de cada módulo, en vez de que cada pantalla tenga la siguiente URL escrita a mano.
- **STEP 2 CK — Clinical Knowledge** (`steps2.html`, `data/steps2.json`, `js/app-steps2.js`): completo. 8 preguntas originales (caso clínico + 5 opciones, formato USMLE/Step 2 CK), timer de 15 minutos, se aprueba con 75% (6/8) — pass/fail, sin banda CEFR. Solo lo rinde la ruta STEPS2, entre Reading y el Speaking Assessment.
- **OET Skills** — completo (~1 hora en total):
  - Listening: 3 partes (A/B/C), audio de reproducción única, timer independiente por parte calculado a partir de la duración real de cada track — 6/7/9 minutos (`data/oet-listening.json`), preguntas numeradas de punta a punta, subtítulos del "case note completion" de la Parte A en negrita.
  - Reading: 3 partes con timer propio cada una — 6/8/8 minutos, preguntas numeradas de punta a punta.
  - Writing: timer de 17 minutos (2 de lectura + 15 de escritura), caso clínico siempre visible (sin colapsar), consigna + calificación por IA.
- **Speaking Assessment**: `speaking.html` muestra el link correcto de Google Calendar (roleplay OET o conversación CEFR English) según el resultado del estudiante. **Esto aplica a las dos pistas** — `NIVEL1_ONLY` también termina en `speaking.html` y agenda su sesión en vivo igual que `FULL_360` (corregido en este documento el 14/08/2026: una versión anterior decía lo contrario). Desde el 11/08/2026, cada clic en "Agendar" queda registrado en `speaking_assessment_bookings` (`register-speaking-booking`, idempotente por `attempt_id`). Desde el 12/08/2026, Diana carga el resultado de esa sesión en vivo desde una página interna nueva, `admin-speaking-score.html` (con login propio, no accesible a estudiantes) — ver más abajo.
- **Reporte de resultados automático** (`generate-report`, agregado 10/08/2026, extendido 12/08/2026): al completar un assessment, arma un PDF con los resultados de todas las skills y lo manda por correo a Diana (nunca al estudiante) vía Resend. Se dispara automáticamente al cargar el score de Speaking (`submit-speaking-score`) — y como **ambas** pistas pasan por Speaking, esto ya cubre `FULL_360` y `NIVEL1_ONLY` de punta a punta (corregido el 14/08/2026; una versión anterior de este documento decía que `NIVEL1_ONLY` no generaba reporte automático, eso era un error).
- **Carga de resultados de Speaking sin tocar Supabase a mano** (`admin-speaking-score.html` + Edge Functions `submit-speaking-score` / `list-pending-speaking-scores`, agregado 12/08/2026): página interna, protegida con un login real de Supabase Auth (no la clave pública del sitio), donde Diana ve la lista de reservas de Speaking pendientes de calificar y carga el resultado con la rúbrica oficial correspondiente — 9 criterios de OET Speaking (4 lingüísticos + 5 de comunicación clínica) para la ruta médica, o nivel CEFR + checklist de pronunciación para la ruta English. Al guardar, dispara el reporte automático si con eso el assessment queda completo.
- **Dashboard interno de estado** (`assessment-dashboard.html` + Edge Function `get-dashboard-stats`, agregado 14/08/2026): panel con estadísticas en tiempo real (estudiantes, assessments completados, bookings de Speaking, accuracy por módulo, etc.), protegido con el mismo login de Supabase Auth que `admin-speaking-score.html`. Reemplaza una versión anterior que leía las vistas de Supabase directo con la clave pública del sitio — dejó de funcionar el 12/08/2026 cuando se corrigió el permiso de esas vistas (ver nota de seguridad) y por eso se reconstruyó detrás de una Edge Function protegida.
- **Producto "solo Nivel 1" (`NIVEL1_ONLY`)** (agregado 07-08/08/2026): segmento de estudiantes que rinde únicamente Nivel 1 — English Level, sin pasar nunca por STEPS 2 ni OET, sin importar el resultado. Entran por `index-nivel1.html` (en vez de `index.html`), que manda `track: 'NIVEL1_ONLY'` a `login`; el `attempt` guarda ese track de forma permanente y `welcome-nivel1.html` muestra el branding correspondiente. Como esta pista es de público general (no médicos preparando OET), Listening y Reading usan **contenido separado y no médico**: `data/nivel1-listening-general.json` (5 audios: reservar mesa, pedido online, hotel, call center, IA en RRHH) y `data/nivel1-reading-general.json` (7 textos). En Supabase viven bajo módulos propios (`nivel1_listening_general` / `nivel1_reading_general`, separados de `nivel1_listening` / `nivel1_reading` que sigue usando la pista `FULL_360`) para que el conteo de módulo completo no se mezcle entre las dos pistas. `submit-response` mapea ambos módulos nuevos a los skills `listening`/`reading` para que el ceiling CEFR funcione igual que en la pista completa — este mapeo tuvo un bug (los dos módulos `_general` faltaban en `MODULE_TO_SKILL`, así que Listening/Reading de esta pista nunca generaban `sub_score`) corregido el 12/08/2026.
- **Identidad visual**: logo real de Speak Easy · ClearPath integrado en todas las pantallas de la pista `FULL_360`; la pista `NIVEL1_ONLY` usa en cambio el logo genérico de Speak Easy (sin "ClearPath") en login, welcome, Listening y Reading.
- **Registro automático de estudiantes (RPS)**: el formulario "ASSESSMENT 360 - STUDENT INTAKE" (Google Forms) está conectado vía Google Apps Script a la Edge Function `register-student`, que crea el estudiante en Supabase con un código de acceso único (`CP-XXXXXX`) y le envía un correo automático con ese código (con copia para Speak Easy). Pensado para que RPS lo complete cada vez que se vende un Assessment 360, después de confirmar el pago.
- **Edge Functions desplegadas**: `login`, `submit-intake`, `submit-response`, `submit-writing`, `get-unlock-state`, `get-audio-url`, `get-module-progress`, `register-student`, `register-speaking-booking`, `generate-report`, `submit-speaking-score`, `list-pending-speaking-scores`, `get-dashboard-stats`. También existe `debug-anthropic`, una función de diagnóstico interno para probar la conexión con la API de Anthropic (no forma parte del flujo del estudiante). Ver el Brief (sección 3.3) para el número de versión de cada una.
- **Esquema de base de datos para Supabase** (`supabase/migrations/0001_init_schema.sql`), pensado para que el frontend público nunca pueda leer las respuestas correctas ni las reglas de desbloqueo directamente.

Lo que falta (backlog):

- **[Nuevo, 14/08/2026] Posible bug: `NIVEL1_ONLY` no está capado a la ruta ENGLISH.** La asignación de ruta (`recomputeRouteAndPersist` en `submit-response`/`submit-writing`) calcula `OET`/`STEPS2`/`ENGLISH` solo a partir de los 4 niveles CEFR, sin mirar el `track` del attempt. Si un estudiante de `NIVEL1_ONLY` saca B2 en las 4 destrezas, hoy quedaría asignado a la ruta OET (o STEPS2) y `get-unlock-state` lo mandaría a `oet-listening.html`/`steps2.html` — módulos con contenido médico que no le corresponden a este producto. Todavía no impactó a ningún estudiante real (nadie de `NIVEL1_ONLY` completó Nivel 1 con ese resultado hasta ahora), pero conviene corregirlo antes de que pase. Ver Brief, sección 6.8.
- Corregir la estructura de carpetas de las 3 Edge Functions nuevas (`submit-speaking-score`, `list-pending-speaking-scores`, `generate-report`): quedaron subidas como archivo suelto en `supabase/functions/` en vez de `supabase/functions/<nombre>/index.ts` como el resto — no afecta lo desplegado (ya está en Supabase), pero rompe si algún día se usa `supabase functions deploy` desde el repo.
- Reporte para el estudiante (hoy el reporte automático es solo para Diana; reenviarlo es una decisión manual de ella).
- Limpiar los módulos "archivo" de `question_bank` (`nivel1_grammar_archivo`, `nivel1_listening_archivo`, `nivel1_reading_archivo_v1`) — contenido reemplazado, sin usar.
- Definir si un estudiante puede reintentar el assessment completo (hoy no existe ningún mecanismo de reintento).
- Revisar las 6 advertencias de seguridad de severidad baja (`search_path` mutable en funciones internas) que quedaron anotadas tras la auditoría del 12/08/2026.

## ⚠️ Nota de seguridad importante

Los audios y las respuestas correctas **no deben subirse nunca a este repositorio**. Este repo es público y solo debe contener código (HTML/CSS/JS) y el banco de preguntas *sin* marcar cuál es la correcta si en algún momento se sirve directo al navegador. El contenido protegido (audios, respuestas correctas, rúbricas) vive en Supabase, detrás de Row Level Security y Edge Functions — ver el comentario al inicio de `supabase/migrations/0001_init_schema.sql`.

El 12/08/2026 se detectó y corrigió una vista (`student_progress_summary`) que tenía permiso de lectura otorgado al rol público `anon` y corría con privilegios de superusuario (bypaseando Row Level Security) — cualquiera con la clave pública del sitio podía leer el listado completo de estudiantes, incluyendo `access_code`. Se le sacó el permiso a `anon`/`authenticated` y se le fijó `security_invoker = on`. Si en el futuro se crean vistas nuevas sobre tablas con RLS, hay que revisar explícitamente a qué roles se les da `SELECT`.

## Cómo probarlo localmente

```bash
python3 -m http.server 8899
# abrir http://localhost:8899/index.html
```

## Cómo correr los tests

```bash
# lógica de scoring (Node, sin dependencias)
node js/scoring.test.mjs

# flujo completo end-to-end (requiere Playwright y el server local corriendo)
node test-flow.mjs
```
