# Brief — ClearPath Assessment 360

**Actualizado:** 8 de agosto de 2026 (se agregó y verificó el producto "solo Nivel 1" — pista `NIVEL1_ONLY` con contenido de Listening/Reading no médico, separado de la pista `FULL_360` original; ver secciones 1, 3 y 5)
**Preparado por:** Claude, a partir de la revisión completa del repositorio (`SpeakEasyLat/clearpath-assessment-360`), la base de datos y las Edge Functions de Supabase (proyecto `qqdxmmvhthwcqhgmvyic`), y del historial de esta conversación.

> **Nota sobre el alcance de este brief:** no tengo forma de leer conversaciones de otras sesiones de chat fuera de esta. Este documento se armó revisando el estado *real* de las cosas — el código del repositorio, el esquema y los datos actuales de Supabase, y las Edge Functions desplegadas — en vez de basarme solo en lo que se haya dicho en el chat. Reemplaza por completo la versión del 9 de julio de 2026, que había quedado desactualizada (no mencionaba Reading, OET, STEPS 2 ni la pista `NIVEL1_ONLY`, todos construidos después).

---

## 1. Qué es el proyecto

Assessment 360 es una plataforma de evaluación de inglés para Speak Easy. Hoy conviven **dos productos** sobre la misma base de código y el mismo backend:

- **`FULL_360`** (producto original, pista por defecto): pensado para médicos que preparan el examen OET dentro del pathway ABR de radiología. Recorrido completo:

  **English Level (Nivel 1) → STEPS 2 *o* OET Skills, según el resultado → Speaking Assessment (sesión en vivo)**

  con desbloqueo adaptativo según el desempeño del estudiante y audios de reproducción limitada imitando el formato real del examen OET.

- **`NIVEL1_ONLY`** (agregado 07-08/08/2026): un segmento de estudiantes de público general que rinde **únicamente** Nivel 1 — English Level, sin pasar nunca por STEPS 2 ni OET, sin importar el resultado. Entra por una puerta separada (`index-nivel1.html`) y usa contenido de Listening/Reading no médico, ya que estos estudiantes no son necesariamente profesionales de la salud.

- **Repositorio (público):** `github.com/SpeakEasyLat/clearpath-assessment-360`
- **Sitio en vivo:** `assessment.speakeasy.lat` (GitHub Pages)
- **Backend:** Supabase, proyecto `qqdxmmvhthwcqhgmvyic`, región `sa-east-1`

---

## 2. Reglas no negociables del proyecto

Estas reglas rigen **todo** el desarrollo, sin excepción:

1. **Seguridad de contenido protegido.** Los audios y las respuestas correctas nunca deben subirse al repositorio público de GitHub. Todo el contenido protegido (audios, `correct_answer`, rúbricas de writing) vive en Supabase, detrás de Row Level Security y Edge Functions. La `service_role key` nunca se expone en el frontend/navegador.
2. **Idioma.** Todo el texto de cara al estudiante y también el texto para desarrolladores (comentarios de código, commits, este brief) va en español latinoamericano, con "tú" (nunca voseo), y con tildes y "ñ" correctos. Excepción: STEP 2 CK y el contenido en inglés de Listening/Reading/Writing/OET, que son el material del examen en sí.
3. **Sin feedback en vivo.** El estudiante nunca ve si acertó o no una pregunta, ni ningún puntaje parcial mientras rinde el examen. Solo se le confirma que su respuesta se guardó, o que terminó el módulo. Diana revisa los resultados completos después.

---

## 3. Arquitectura técnica

### 3.1 Estructura del repositorio (actual)

```
index.html               → login pista FULL_360 (código de acceso)
index-nivel1.html         → login pista NIVEL1_ONLY (branding distinto, manda track: 'NIVEL1_ONLY' a login)
welcome.html               → bienvenida FULL_360
welcome-nivel1.html        → bienvenida NIVEL1_ONLY
intake.html                 → formulario previo (no calificado)
nivel1.html                 → Nivel 1, Grammar
nivel1-listening.html       → Nivel 1, Listening (sirve contenido médico o general según sessionStorage.cp360_track)
nivel1-reading.html         → Nivel 1, Reading (idem)
nivel1-writing.html         → Nivel 1, Writing
siguiente.html              → router: pregunta a get-unlock-state a qué pantalla mandar al estudiante
steps2.html                 → STEP 2 CK (solo ruta STEPS2)
oet-listening.html / oet-reading.html / oet-writing.html → OET Skills (solo ruta OET)
speaking.html                → agenda del Speaking Assessment (link de Calendar según ruta/tipo)
css/style.css
js/app-intake.js, app-nivel1.js, app-nivel1-listening.js, app-nivel1-reading.js, app-nivel1-writing.js
js/app-steps2.js, app-oet-listening.js, app-oet-reading.js, app-oet-writing.js
js/scoring.js               → algoritmo CEFR + reglas de desbloqueo (puro, con tests) — usado como preview client-side
js/scoring.test.mjs
js/fetch-retry.js
data/nivel1-grammar.json, nivel1-listening.json, nivel1-reading.json, nivel1-writing.json  → contenido FULL_360 (médico)
data/nivel1-listening-general.json, nivel1-reading-general.json                            → contenido NIVEL1_ONLY (general, no médico) — nuevo 08/08/2026
data/oet-listening.json, oet-reading.json, oet-writing.json, steps2.json
supabase/functions/ → código fuente de las Edge Functions (login, submit-intake, submit-response, get-audio-url, submit-writing; get-unlock-state y register-student aún no bajados al repo, ver 6.1)
supabase/migrations/ → migraciones SQL (esquema inicial + ajustes posteriores)
CNAME → assessment.speakeasy.lat
```

### 3.2 Base de datos (Supabase, esquema actual en producción — filas al 08/08/2026)

| Tabla | Filas hoy | Para qué sirve |
|---|---|---|
| `students` | 6 | Estudiantes, con `access_code` único que Diana genera a mano (o que emite `register-student`) tras confirmar el pago |
| `attempts` | 2 | Una corrida completa del Assessment 360. Tiene `track` (`FULL_360` default / `NIVEL1_ONLY`), fijado al crear el attempt y conservado si se retoma uno existente. Las 2 filas actuales son ambas `NIVEL1_ONLY` (cuentas de prueba) — todavía no hay ningún estudiante real que haya iniciado sesión |
| `question_bank` | 232 | Banco de preguntas de todos los módulos. Incluye módulos activos y algunos "archivo" (versiones viejas de Listening/Reading/Grammar que se reemplazaron pero se dejaron sin borrar — ver detalle abajo) |
| `student_responses` | 48 | Respuestas guardadas server-side, con `is_correct` calculado por `submit-response` |
| `sub_scores` | 2 | Ceiling CEFR (o pass/fail para STEP CK 2, o puntaje informativo para OET) por habilidad |
| `unlock_state` | 2 | Ruta asignada (`OET`/`STEPS2`/`ENGLISH`), si se desbloqueó STEPS2/OET, y qué tipo de Speaking Assessment corresponde |
| `audio_assets` | 13 | Metadata de los audios de Listening (`storage_path`, `max_plays`, `module`) — incluye los 5 nuevos de la pista `NIVEL1_ONLY` |
| `audio_play_log` | 5 | Registro de reproducciones ya usadas, para hacer cumplir `max_plays` |
| `writing_prompts` | 3 | Consignas de Writing: `nivel1_writing` tiene 2 (una general "An email about your country", una médica "A referral letter to a community nurse" — ver nota en 6.3), `oet_writing` tiene 1 |
| `writing_submissions` | 0 | Texto de cada tarea de Writing + calificación de IA (`ai_rubric_scores`, `cefr_estimate`) |
| `speaking_assessment_bookings` | 0 | Reservada para agendar la sesión en vivo — la tabla existe, no hay UI de agenda todavía |
| `attempt_sessions` | 2 | Tokens de sesión (expiran 4 h después del login) |
| `intake_responses` | 0 | Respuestas del formulario previo (no calificado) |

Desglose de `question_bank` por módulo (232 filas totales):

| Módulo | Preguntas | Pista |
|---|---|---|
| `nivel1_grammar` | 20 | FULL_360 y NIVEL1_ONLY (compartido) |
| `nivel1_grammar_archivo` | 24 | — versión vieja, sin usar |
| `nivel1_listening` | 20 | FULL_360 (médico) |
| `nivel1_listening_archivo` | 34 | — versión vieja, sin usar |
| `nivel1_listening_general` | 20 | NIVEL1_ONLY (nuevo, no médico) |
| `nivel1_reading` | 28 | FULL_360 (médico) |
| `nivel1_reading_archivo_v1` | 12 | — versión vieja, sin usar |
| `nivel1_reading_general` | 28 | NIVEL1_ONLY (nuevo, no médico) |
| `oet_listening` | 22 | solo ruta OET |
| `oet_reading` | 16 | solo ruta OET |
| `steps2` | 8 | solo ruta STEPS2 |

Los módulos "archivo" quedaron en la base sin borrar tras reemplazos de contenido anteriores; no los usa ningún JSON ni Edge Function activos — son candidatos a limpieza (ver backlog, sección 7).

Row Level Security está habilitado en todas las tablas. El frontend público nunca lee `correct_answer` directamente; todo pasa por Edge Functions con `service_role`.

Storage: bucket privado `audio-assets`, cero políticas de acceso directo para `anon`/`authenticated` — las URLs firmadas las emite `get-audio-url`.

### 3.3 Edge Functions desplegadas

| Función | Versión | Qué hace |
|---|---|---|
| `login` | v8 | Valida `access_code` contra `students`, crea/retoma `attempt` (fija `track` solo al crear uno nuevo), emite `session_token` (expira en 4 h). Acepta `track: 'NIVEL1_ONLY'` en el body (lo manda `index-nivel1.html`); default `FULL_360` |
| `submit-intake` | v7 | Guarda el formulario previo (no calificado) |
| `submit-response` | **v15** | Corrige la respuesta server-side (multiple_choice o note_completion), la guarda, y si con eso se completa el módulo calcula el sub_score y recalcula la ruta del Nivel 1. `MODULE_TO_SKILL` mapea `nivel1_listening_general`/`nivel1_reading_general` a los mismos skills `listening`/`reading` que sus contrapartes médicas. Si `attempt.track === 'NIVEL1_ONLY'`, la ruta queda siempre en `ENGLISH` sin evaluar los 4 sub_scores |
| `get-audio-url` | v5 | Valida sesión + `max_plays`, emite URL firmada, registra la reproducción |
| `submit-writing` | v18 | Guarda cada tarea de Writing, la califica con IA (rúbrica de placement 0-10 combinada con CEFR), escribe `sub_scores` y recalcula la ruta (lógica duplicada intencionalmente respecto a `submit-response` — mantener sincronizadas) |
| `get-unlock-state` | v7 | Le dice a `siguiente.html` a qué pantalla mandar al estudiante según los sub_scores/ruta ya calculados |
| `register-student` | v3 | Crea un estudiante nuevo con `access_code` único (`CP-XXXXXX`) a partir del formulario de intake de RPS (Google Forms → Apps Script), y le envía el código por correo |
| `debug-anthropic` | v6 | Utilidad interna para probar la conexión con la API de Anthropic; no forma parte del flujo del estudiante |

### 3.4 Algoritmo de scoring y reglas de desbloqueo

- **Ceiling CEFR por banda** (`js/scoring.js` y replicado en `submit-response`/`submit-writing`): para cada módulo tipo "escalera" (grammar, listening, reading), se sube de A1 en adelante mientras cada banda CEFR supere el 70% de acierto. En cuanto una banda no llega al umbral, ahí se corta el ceiling.
- **STEP CK 2**: pass/fail puro (≥75% para aprobar), sin bandas CEFR — sus preguntas tienen `cefr_level = null`.
- **OET Listening/Reading**: puntaje informativo únicamente (raw_score/max_score), sin banda ni aprobar/reprobar — estos estudiantes ya calificaron para OET en Nivel 1.
- **Ruta del Nivel 1** (pista `FULL_360`, tres ramas mutuamente excluyentes, se calcula recién cuando existen los 4 sub_scores de Nivel 1 — grammar, listening, writing, reading):
  - Si los 4 llegan a B2 → ruta **OET**.
  - Si no, pero reading llega a B2 → ruta **STEPS2**.
  - Si reading tampoco llega → ruta **ENGLISH**.
- **Pista `NIVEL1_ONLY`**: en cuanto están los 4 sub_scores de Nivel 1, la ruta queda **siempre** en `ENGLISH` (Speaking Assessment breve tipo English), sin evaluar los sub_scores — sin importar el resultado.
- Esta lógica está **duplicada intencionalmente** en `js/scoring.js` (preview client-side), `submit-response` y `submit-writing`. Si se cambia algún umbral, hay que tocar los tres lugares.
- `detectPatternInconsistency()` deja registrado en `sub_scores.band_detail` si el patrón de aciertos por banda es inconsistente (ej. falla B1 pero aprueba B2) — solo diagnóstico, nunca bloquea ni cambia el ceiling asignado.
- Cubierto por 7 casos de test en `js/scoring.test.mjs` (`node js/scoring.test.mjs`).

---

## 4. Estado actual por módulo

| Módulo | Estado |
|---|---|
| **Login / sesión** (ambas pistas) | ✅ Completo y funcionando en producción |
| **Intake** | ✅ Completo, no calificado |
| **Nivel 1 — Grammar** | ✅ Completo (20 preguntas, compartidas entre ambas pistas) |
| **Nivel 1 — Listening** | ✅ Completo en ambas pistas: `FULL_360` usa contenido médico (5 audios, 20 preguntas); `NIVEL1_ONLY` usa contenido general no médico (5 audios, 20 preguntas, nuevo 08/08/2026), servidos desde JSON y módulos separados en Supabase |
| **Nivel 1 — Reading** | ✅ Completo en ambas pistas: `FULL_360` usa contenido médico (7 textos, 28 preguntas); `NIVEL1_ONLY` usa contenido general (7 textos, 28 preguntas — 4 reemplazados + 3 reutilizados del set médico que ya eran genéricos, nuevo 08/08/2026) |
| **Nivel 1 — Writing** | ✅ Completo, calificación por IA. Nota: `nivel1_writing` todavía tiene 2 consignas cargadas (una general, una médica tipo carta de derivación) para ambas pistas por igual — no se filtra por track (ver 6.3, no es parte del alcance de esta actualización) |
| **STEPS 2** (solo ruta STEPS2, pista `FULL_360`) | ✅ Completo: 8 preguntas, timer 15 min, pass/fail ≥75% |
| **OET Skills** (solo ruta OET, pista `FULL_360`) | ✅ Completo: Listening (22 preguntas, 3 partes), Reading (16 preguntas, 3 partes), Writing con calificación por IA |
| **Speaking Assessment** | 🟡 Pantalla de agenda (`speaking.html`) completa; la reserva en sí todavía no persiste en `speaking_assessment_bookings` (tabla vacía) |
| **Producto "solo Nivel 1" (`NIVEL1_ONLY`)** | ✅ Wireado y verificado de punta a punta hoy (ver sección 5): entrada, branding, contenido general de Listening/Reading, scoring y ruta forzada a `ENGLISH` |

### 5. Trabajo de hoy (08/08/2026): pista `NIVEL1_ONLY` con contenido general

Diana pidió agregar el segmento de estudiantes que solo rinde Nivel 1 (sin STEPS2/OET), y que como no son necesariamente médicos, Listening y Reading no debían mostrarles contenido clínico. El trabajo de hoy fue:

1. **Contenido nuevo**: 5 audios de Listening (reservar mesa en un restaurante, problema con un pedido online, check-in de hotel, cambio de turno en un call center, IA en reclutamiento — bandas A1 a C1) y 7 textos de Reading (4 nuevos: horario de biblioteca, recordatorio de clase, oficina open-plan, política de offboarding de RRHH; 3 reutilizados del set médico que ya eran de tema general: sueño y aprendizaje, trabajo remoto, límites de datos autorreportados), cargados en Supabase bajo los módulos nuevos `nivel1_listening_general` / `nivel1_reading_general` — **separados** de `nivel1_listening`/`nivel1_reading` para que el conteo de "módulo completo" de `submit-response` no mezcle las 20/28 preguntas generales con las 20/28 médicas (mismo patrón que ya separaba `oet_listening`/`oet_reading`).
2. **Backend**: se extendió `MODULE_TO_SKILL` en `submit-response` (v13 → v15 con los ajustes intermedios) para mapear los dos módulos nuevos a los skills `listening`/`reading` de siempre, así el ceiling CEFR y la ruta funcionan igual para ambas pistas.
3. **Frontend**: `js/app-nivel1-listening.js` y `js/app-nivel1-reading.js` ahora eligen qué JSON cargar (`-general.json` o el médico) según `sessionStorage.cp360_track`, seteado por `index-nivel1.html` en el login.
4. **Verificación en vivo** (cuenta de prueba `CP-QA0808N1`, creada y usada solo para esta prueba): login por `index-nivel1.html` → logo de Speak Easy genérico correcto en las 4 pantallas (login, welcome, Listening, Reading) → Listening completo (5 audios, reproducción, 20 respuestas guardadas y corregidas correctamente, `sub_score.listening` = 15/20) → Reading completo (7 textos, 28 respuestas guardadas y corregidas correctamente, `sub_score.reading` = 28/28, CEFR C1) → cero errores en la consola del navegador en todo el recorrido → `attempts.track` confirmado como `NIVEL1_ONLY` en la base.

---

## 6. Pendientes conocidos (no bloqueantes)

### 6.1 🟡 `get-unlock-state` y `register-student` no están en el repositorio

Estas dos Edge Functions están desplegadas y activas en Supabase (v7 y v3 respectivamente) pero su código fuente no se bajó nunca a `supabase/functions/` en el repo — a diferencia de `login`, `submit-intake`, `submit-response`, `get-audio-url` y `submit-writing`, que sí están sincronizadas. El repo no es la fuente de verdad completa de lo desplegado.

### 6.2 🟡 Módulos "archivo" sin borrar en `question_bank`

`nivel1_grammar_archivo` (24), `nivel1_listening_archivo` (34) y `nivel1_reading_archivo_v1` (12) son versiones de contenido reemplazadas que quedaron en la tabla sin usar. No rompen nada (ningún JSON ni Edge Function las referencia), pero conviene limpiarlas en algún momento para que `question_bank` no acumule filas muertas.

### 6.3 🟡 Writing no distingue pista `NIVEL1_ONLY` de `FULL_360`

A diferencia de Listening y Reading, `nivel1_writing` sigue teniendo las mismas 2 consignas (una general, una médica tipo carta de derivación a enfermería comunitaria) para **ambas** pistas — no se filtra por `sessionStorage.cp360_track` ni por módulo separado. Si Diana quiere que `NIVEL1_ONLY` tampoco vea la consigna médica de Writing, es un trabajo pendiente con el mismo patrón que se usó hoy para Listening/Reading. No se tocó esta sesión porque no fue parte del pedido.

### 6.4 🟡 Otros detalles menores

- `speaking_assessment_bookings` sigue vacía — la agenda del Speaking Assessment muestra el link de Calendar correcto, pero no queda registro en la base de que el estudiante reservó.
- Ningún estudiante real (de los 6 cargados) inició sesión todavía — las únicas 2 filas en `attempts` son de cuentas de prueba (`dianapruebanivel1` y `CP-QA0808N1`).
- `test-flow.mjs` (Playwright) solo cubre login → intake; no se actualizó para cubrir Listening/Reading ni la pista `NIVEL1_ONLY`.

---

## 7. Backlog priorizado (sugerido)

1. Bajar el código fuente real de `get-unlock-state` y `register-student` al repo (ver 6.1), para que quede sincronizado igual que las demás.
2. Decidir si Writing también necesita una versión sin contenido médico para `NIVEL1_ONLY` (ver 6.3).
3. Persistir el progreso del estudiante dentro de un módulo (parte actual, tiempo restante, reproducciones de audio usadas) — hoy vive solo en memoria del navegador; si recarga la página a mitad de un módulo, vuelve al principio.
4. Construir el flujo de reserva del Speaking Assessment (`speaking_assessment_bookings` existe pero no se escribe desde ningún lado).
5. Reporte final para el estudiante y panel de resultados para Diana (hoy se revisa por consulta SQL directa).
6. Limpiar los módulos "archivo" de `question_bank` (ver 6.2).
7. Definir si un estudiante puede reintentar el assessment completo (hoy no existe mecanismo de reintento).
8. Actualizar `test-flow.mjs` para cubrir Listening/Reading y la pista `NIVEL1_ONLY`.

---

## 8. Notas técnicas para la próxima sesión

- El patrón correcto para cualquier módulo nuevo de examen es el que usa Listening/Reading: el frontend nunca calcula si algo es correcto, siempre llama a `submit-response` con `session_token` + `question_id` + `selected_answer`, y la Edge Function hace todo el trabajo (calificar, guardar, y si el módulo se completa, recalcular `sub_scores` y la ruta).
- Cuando se agrega contenido nuevo que debe convivir con uno existente sin mezclarse en el conteo de "módulo completo", usar un `module` (string) separado en `question_bank`/`audio_assets`, y extender `MODULE_TO_SKILL` en `submit-response` para que apunte al mismo `skill` — nunca reutilizar el mismo nombre de módulo para dos sets de contenido distintos.
- `sessionStorage.cp360_track` decide branding y qué contenido pedir en el navegador; `attempts.track` (columna en Supabase) es la fuente de verdad server-side para decidir la ruta — hay que mantener los dos en sync desde `login`, pero son cosas distintas y no intercambiables.
- Todas las claves usadas en el frontend (`SUPABASE_ANON_KEY`) son la clave **anon/publishable**, no la `service_role` — está bien que estén hardcodeadas en el JS público, es el diseño intencional.
- Este repositorio (`SpeakEasyLat/clearpath-assessment-360`) permite lectura desde sesiones de Claude en la nube, pero **no** push directo — los cambios de código de una sesión en la nube hay que entregárselos a Diana como archivos para que los suba ella misma vía GitHub (editar/reemplazar archivo o "Add file → Upload files"), no asumir que un `git push` va a funcionar.
