# Brief — ClearPath Assessment 360

**Actualizado:** 14 de agosto de 2026 (fix del dashboard interno de Diana, que había quedado roto por el fix de seguridad del 12/08; corrección de un error de este mismo documento sobre `NIVEL1_ONLY` y Speaking; y un bug nuevo encontrado en la asignación de ruta para `NIVEL1_ONLY` — ver sección 5)
**Preparado por:** Claude, a partir de la revisión completa del repositorio (`SpeakEasyLat/clearpath-assessment-360`), la base de datos y las Edge Functions de Supabase (proyecto `qqdxmmvhthwcqhgmvyic`), y del historial de esta conversación.

> **Nota sobre el alcance de este brief:** no tengo forma de leer conversaciones de otras sesiones de chat fuera de esta. Este documento se armó revisando el estado *real* de las cosas — el código del repositorio, el esquema y los datos actuales de Supabase, y las Edge Functions desplegadas — en vez de basarme solo en lo que se haya dicho en el chat. Reemplaza por completo la versión del 8 de agosto de 2026.

---

## 1. Qué es el proyecto

Assessment 360 es una plataforma de evaluación de inglés para Speak Easy. Hoy conviven **dos productos** sobre la misma base de código y el mismo backend:

- **`FULL_360`** (producto original, pista por defecto): pensado para médicos que preparan el examen OET dentro del pathway ABR de radiología. Recorrido completo:

  **English Level (Nivel 1) → STEPS 2 *o* OET Skills, según el resultado → Speaking Assessment (sesión en vivo)**

  con desbloqueo adaptativo según el desempeño del estudiante y audios de reproducción limitada imitando el formato real del examen OET.

- **`NIVEL1_ONLY`** (agregado 07-08/08/2026): un segmento de estudiantes de público general que rinde **únicamente** Nivel 1 — English Level, sin pasar nunca por STEPS 2 ni OET, sin importar el resultado. Entra por una puerta separada (`index-nivel1.html`) y usa contenido de Listening/Reading no médico, ya que estos estudiantes no son necesariamente profesionales de la salud.

Desde el 12/08/2026, el resultado final de cada assessment (todas las skills) se arma automáticamente en un PDF y se manda por correo a Diana apenas queda completo — antes esto se revisaba solo por consulta SQL directa. Ver sección 5.

- **Repositorio (público):** `github.com/SpeakEasyLat/clearpath-assessment-360`
- **Sitio en vivo:** `assessment.speakeasy.lat` (GitHub Pages)
- **Backend:** Supabase, proyecto `qqdxmmvhthwcqhgmvyic`, región `sa-east-1`

---

## 2. Reglas no negociables del proyecto

Estas reglas rigen **todo** el desarrollo, sin excepción:

1. **Seguridad de contenido protegido.** Los audios y las respuestas correctas nunca deben subirse al repositorio público de GitHub. Todo el contenido protegido (audios, `correct_answer`, rúbricas de writing) vive en Supabase, detrás de Row Level Security y Edge Functions. La `service_role key` nunca se expone en el frontend/navegador.
2. **Idioma.** Todo el texto de cara al estudiante y también el texto para desarrolladores (comentarios de código, commits, este brief) va en español latinoamericano, con "tú" (nunca voseo), y con tildes y "ñ" correctos. Excepción: STEP 2 CK y el contenido en inglés de Listening/Reading/Writing/OET, que son el material del examen en sí.
3. **Sin feedback en vivo.** El estudiante nunca ve si acertó o no una pregunta, ni ningún puntaje parcial mientras rinde el examen. Solo se le confirma que su respuesta se guardó, o que terminó el módulo. Diana revisa los resultados completos después.
4. **Cualquier vista o tabla nueva sobre datos de estudiantes debe revisar explícitamente los permisos por rol** (`anon`/`authenticated`/`service_role`) y, si es una vista, fijar `security_invoker = on` — ver el incidente de seguridad de la sección 5 (12/08/2026).

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
nivel1-writing.html         → Nivel 1, Writing (idem)
siguiente.html              → router: pregunta a get-unlock-state a qué pantalla mandar al estudiante
steps2.html                 → STEP 2 CK (solo ruta STEPS2)
oet-listening.html / oet-reading.html / oet-writing.html → OET Skills (solo ruta OET)
speaking.html                → agenda del Speaking Assessment (link de Calendar según ruta/tipo, registra el booking)
admin-speaking-score.html    → NUEVO (12/08/2026): página interna para que Diana cargue el resultado de Speaking, con login propio de Supabase Auth
assessment-dashboard.html    → NUEVO (14/08/2026): dashboard interno de estado (estudiantes, bookings, accuracy), mismo login que admin-speaking-score.html — reemplaza una versión anterior (assessmentdashboardv2_2.html, nunca vivió en este repo) que leía Supabase directo con la clave pública
.nojekyll                    → NUEVO (10/08/2026): evita que GitHub Pages procese el sitio con Jekyll (ver 5)
css/style.css
js/app-intake.js, app-nivel1.js, app-nivel1-listening.js, app-nivel1-reading.js, app-nivel1-writing.js
js/app-steps2.js, app-oet-listening.js, app-oet-reading.js, app-oet-writing.js
js/scoring.js               → algoritmo CEFR + reglas de desbloqueo (puro, con tests) — usado como preview client-side
js/scoring.test.mjs
js/fetch-retry.js
data/nivel1-grammar.json, nivel1-listening.json, nivel1-reading.json, nivel1-writing.json  → contenido FULL_360 (médico)
data/nivel1-listening-general.json, nivel1-reading-general.json, nivel1-writing-general.json → contenido NIVEL1_ONLY (general, no médico)
data/oet-listening.json, oet-reading.json, oet-writing.json, steps2.json
supabase/functions/ → código fuente de las Edge Functions. Todas siguen el patrón <nombre>/index.ts, EXCEPTO
                       submit-speaking-score, list-pending-speaking-scores y generate-report, que quedaron
                       subidas como archivo suelto (sin carpeta) — pendiente de corregir, ver 6.5.
supabase/migrations/ → migraciones SQL (esquema inicial + ajustes posteriores)
CNAME → assessment.speakeasy.lat
```

### 3.2 Base de datos (Supabase, esquema actual en producción — filas al 12/08/2026)

| Tabla | Filas hoy | Para qué sirve |
|---|---|---|
| `students` | 11 | Estudiantes, con `access_code` único que Diana genera a mano (o que emite `register-student`) tras confirmar el pago |
| `attempts` | 1 | Una corrida completa del Assessment 360. Tiene `track` (`FULL_360` default / `NIVEL1_ONLY`) y `report_sent_at` (marca si ya se le mandó el reporte automático a Diana para ese attempt) |
| `question_bank` | 232 | Banco de preguntas de todos los módulos. Incluye módulos activos y algunos "archivo" (versiones viejas de Listening/Reading/Grammar que se reemplazaron pero se dejaron sin borrar — ver detalle abajo) |
| `student_responses` | 0 | Respuestas guardadas server-side, con `is_correct` calculado por `submit-response` |
| `sub_scores` | 0 | Ceiling CEFR (o pass/fail para STEP CK 2, o puntaje informativo para OET) por habilidad |
| `unlock_state` | 1 | Ruta asignada (`OET`/`STEPS2`/`ENGLISH`), si se desbloqueó STEPS2/OET, y qué tipo de Speaking Assessment corresponde |
| `audio_assets` | 21 | Metadata de los audios de Listening (`storage_path`, `max_plays`, `module`) |
| `audio_play_log` | — | Registro de reproducciones ya usadas, para hacer cumplir `max_plays` |
| `writing_prompts` | 2 | Consignas de Writing: `nivel1_writing` (1) y `oet_writing` (1) — no existe variante `_general`, ambos productos comparten la misma consigna de Nivel 1 |
| `writing_submissions` | 0 | Texto de cada tarea de Writing + calificación de IA (`ai_rubric_scores`, `cefr_estimate`) |
| `speaking_assessment_bookings` | 0 | Reserva de la sesión en vivo (desde 11/08/2026 se escribe de verdad, ver 5) + `evaluator_score` (jsonb) con el resultado que carga Diana desde `admin-speaking-score.html` (desde 12/08/2026) |
| `attempt_sessions` | 2 | Tokens de sesión (expiran 4 h después del login) |
| `intake_responses` | 0 | Respuestas del formulario previo (no calificado) |

Desglose de `question_bank` por módulo (232 filas totales, sin cambios desde el último brief):

| Módulo | Preguntas | Pista |
|---|---|---|
| `nivel1_grammar` | 20 | FULL_360 y NIVEL1_ONLY (compartido) |
| `nivel1_grammar_archivo` | 24 | — versión vieja, sin usar |
| `nivel1_listening` | 20 | FULL_360 (médico) — revisión pedagógica v3, ver 5 |
| `nivel1_listening_archivo` | 34 | — versión vieja, sin usar |
| `nivel1_listening_general` | 20 | NIVEL1_ONLY (no médico) — revisión pedagógica v3, ver 5 |
| `nivel1_reading` | 28 | FULL_360 (médico) — revisión pedagógica v4, ver 5 |
| `nivel1_reading_archivo_v1` | 12 | — versión vieja, sin usar |
| `nivel1_reading_general` | 28 | NIVEL1_ONLY (no médico) — revisión pedagógica v2, ver 5 |
| `oet_listening` | 22 | solo ruta OET |
| `oet_reading` | 16 | solo ruta OET |
| `steps2` | 8 | solo ruta STEPS2 |

Los módulos "archivo" siguen sin usarse y sin borrar (ver backlog, sección 7).

Row Level Security está habilitado en todas las tablas. El frontend público nunca lee `correct_answer` directamente; todo pasa por Edge Functions con `service_role`.

**Vista `student_progress_summary`:** existe una vista de conveniencia (creada fuera de este flujo de trabajo, no vive en las migraciones del repo) que junta `students` + `attempts` + `unlock_state` + `sub_scores` + `speaking_assessment_bookings` para consulta rápida. El 12/08/2026 se detectó que tenía `SELECT` otorgado al rol `anon` y corría con privilegios de superusuario (comportamiento por defecto de las vistas en Postgres, equivalente a `SECURITY DEFINER`), lo que permitía leer el listado completo de estudiantes —incluyendo `access_code`— con solo la clave pública del sitio, sin pasar por RLS. Se corrigió: se le revocó `SELECT` a `anon`/`authenticated` y se le fijó `security_invoker = on`. No se usa desde ninguna pantalla del sitio, así que no hay impacto funcional.

Storage: bucket privado `audio-assets`, cero políticas de acceso directo para `anon`/`authenticated` — las URLs firmadas las emite `get-audio-url`.

### 3.3 Edge Functions desplegadas

| Función | Qué hace |
|---|---|
| `login` | Valida `access_code` contra `students`, crea/retoma `attempt` (fija `track` solo al crear uno nuevo), emite `session_token` (expira en 4 h). Acepta `track: 'NIVEL1_ONLY'` en el body; default `FULL_360` |
| `submit-intake` | Guarda el formulario previo (no calificado) |
| `submit-response` | Corrige la respuesta server-side (multiple_choice o note_completion), la guarda, y si con eso se completa el módulo calcula el sub_score y recalcula la ruta del Nivel 1. **Fix 12/08/2026:** `MODULE_TO_SKILL` no incluía `nivel1_listening_general`/`nivel1_reading_general` — los estudiantes de `NIVEL1_ONLY` nunca generaban `sub_score` de listening/reading, aunque sus respuestas sí quedaban guardadas correctamente. Corregido y verificado end-to-end |
| `get-audio-url` | Valida sesión + `max_plays`, emite URL firmada, registra la reproducción |
| `submit-writing` | Guarda cada tarea de Writing, la califica con IA (rúbrica de placement 0-10 combinada con CEFR), escribe `sub_scores` y recalcula la ruta (lógica duplicada intencionalmente respecto a `submit-response` — mantener sincronizadas). Confirmado que **no** necesitaba el mismo fix que `submit-response`: `writing_prompts` no tiene variante `_general`, ambos productos comparten la misma consigna |
| `get-unlock-state` | Le dice a `siguiente.html` a qué pantalla mandar al estudiante según los sub_scores/ruta ya calculados. Ya está sincronizada en el repo (el brief anterior la marcaba como pendiente de bajar) |
| `get-module-progress` | NUEVO (10/08/2026): devuelve qué preguntas de un módulo de opción múltiple ya tienen respuesta guardada, para que el frontend pueda reanudar un módulo interrumpido en vez de reiniciarlo desde la pregunta 1 |
| `register-student` | Crea un estudiante nuevo con `access_code` único (`CP-XXXXXX`) a partir del formulario de intake de RPS (Google Forms → Apps Script), y le envía el código por correo |
| `register-speaking-booking` | NUEVO (11/08/2026): persiste en `speaking_assessment_bookings` cada clic en "Agendar" en `speaking.html` — antes esa tabla existía pero nunca se insertaba nada ahí. Idempotente por `attempt_id`, fire-and-forget (no bloquea la redirección a Calendar) |
| `generate-report` | NUEVO (10/08/2026), extendido 12/08/2026: arma el PDF de resultados y lo manda por correo a Diana vía Resend cuando el assessment queda completo (idempotente vía `attempts.report_sent_at`). v3 entiende los dos schemas de `evaluator_score` de Speaking (desglose de 9 criterios para OET, o nivel CEFR + checklist de pronunciación para English) y corrigió un bug de paginación del PDF (una tarjeta de resultado se cortaba a la mitad entre dos páginas). **Hoy solo se dispara desde `submit-speaking-score`** — ver pendiente en 6.6 |
| `submit-speaking-score` | NUEVO (12/08/2026): guarda el `evaluator_score` que Diana carga desde `admin-speaking-score.html`, valida que el schema corresponda al tipo de reserva (OET o English) y dispara `generate-report` fire-and-forget. Exige un token de sesión real de Supabase Auth — rechaza explícitamente la clave anon pública |
| `list-pending-speaking-scores` | NUEVO (12/08/2026): lista las reservas de Speaking sin `evaluator_score` cargado todavía, para el selector de `admin-speaking-score.html`. Misma validación de sesión que `submit-speaking-score` |
| `get-dashboard-stats` | NUEVO (14/08/2026): devuelve `student_progress_summary` + `response_statistics` + `completion_times` para `assessment-dashboard.html`. Corre con `service_role` (lee las vistas sin depender de los GRANT de PostgREST) y exige el mismo login real de Supabase Auth que `submit-speaking-score` — nunca se volvió a exponer el permiso público sobre esas vistas |
| `debug-anthropic` | Utilidad interna para probar la conexión con la API de Anthropic; no forma parte del flujo del estudiante |

### 3.4 Algoritmo de scoring y reglas de desbloqueo

- **Ceiling CEFR por banda** (`js/scoring.js` y replicado en `submit-response`/`submit-writing`): para cada módulo tipo "escalera" (grammar, listening, reading), se sube de A1 en adelante mientras cada banda CEFR supere el 70% de acierto. En cuanto una banda no llega al umbral, ahí se corta el ceiling.
- **STEP CK 2**: pass/fail puro (≥75% para aprobar), sin bandas CEFR — sus preguntas tienen `cefr_level = null`.
- **OET Listening/Reading**: puntaje informativo únicamente (raw_score/max_score), sin banda ni aprobar/reprobar — estos estudiantes ya calificaron para OET en Nivel 1.
- **Ruta del Nivel 1** (pista `FULL_360`, tres ramas mutuamente excluyentes, se calcula recién cuando existen los 4 sub_scores de Nivel 1 — grammar, listening, writing, reading):
  - Si los 4 llegan a B2 → ruta **OET**.
  - Si no, pero reading llega a B2 → ruta **STEPS2**.
  - Si reading tampoco llega → ruta **ENGLISH**.
- **Pista `NIVEL1_ONLY`**: el diseño original es que quede **siempre** en Speaking tipo English, sin pasar por STEPS2 ni OET, sin importar el resultado (así lo dice la sección 1). **Pero la implementación actual no lo garantiza** — `recomputeRouteAndPersist` (en `submit-response`/`submit-writing`) calcula la ruta solo a partir de los 4 niveles CEFR, sin mirar `track`, así que un estudiante `NIVEL1_ONLY` con B2 en las 4 destrezas hoy quedaría asignado a `OET` (o `STEPS2`) igual que uno de `FULL_360`, y `get-unlock-state` lo mandaría a los módulos de OET Skills/STEPS 2 con contenido médico. Es un bug encontrado el 14/08/2026, sin impacto real todavía (ver 6.8).
- Esta lógica está **duplicada intencionalmente** en `js/scoring.js` (preview client-side), `submit-response` y `submit-writing`. Si se cambia algún umbral, hay que tocar los tres lugares.
- `detectPatternInconsistency()` deja registrado en `sub_scores.band_detail` si el patrón de aciertos por banda es inconsistente (ej. falla B1 pero aprueba B2) — solo diagnóstico, nunca bloquea ni cambia el ceiling asignado.
- **Nivel CEFR general del reporte** (`generate-report`): es el más bajo entre los 4 skills de Nivel 1 (criterio de "nivel de piso"). No incluye Speaking, OET ni STEPS2 en ese cálculo — esos se muestran aparte en el mismo PDF.
- Cubierto por 7 casos de test en `js/scoring.test.mjs` (`node js/scoring.test.mjs`).

---

## 4. Estado actual por módulo

| Módulo | Estado |
|---|---|
| **Login / sesión** (ambas pistas) | ✅ Completo y funcionando en producción |
| **Reanudar módulo interrumpido** | ✅ Completo (`get-module-progress`, 10/08/2026) |
| **Intake** | ✅ Completo, no calificado |
| **Nivel 1 — Grammar** | ✅ Completo (20 preguntas, compartidas entre ambas pistas) |
| **Nivel 1 — Listening** | ✅ Completo en ambas pistas, con revisión pedagógica completa aplicada el 12/08/2026 (ver 5) |
| **Nivel 1 — Reading** | ✅ Completo en ambas pistas, con revisión pedagógica completa aplicada el 11/08/2026 (ver 5) |
| **Nivel 1 — Writing** | ✅ Completo en ambas pistas |
| **STEPS 2** (solo ruta STEPS2, pista `FULL_360`) | ✅ Completo: 8 preguntas, timer 15 min, pass/fail ≥75% |
| **OET Skills** (solo ruta OET, pista `FULL_360`) | ✅ Completo: Listening (22 preguntas, 3 partes), Reading (16 preguntas, 3 partes), Writing con calificación por IA |
| **Speaking Assessment** | ✅ Agenda + reserva persistida (`speaking_assessment_bookings`) + carga de resultado por Diana (`admin-speaking-score.html`) + reporte automático al completarse. Aplica a las dos pistas (`FULL_360` y `NIVEL1_ONLY`). Cuenta de login de Diana ya creada (13/08/2026) |
| **Reporte de resultados** | ✅ Automático para `FULL_360` y `NIVEL1_ONLY` — ambas pistas terminan en Speaking, y `generate-report` se dispara al cargar ese score (ver corrección en sección 5, 14/08/2026) |
| **Dashboard interno de estado** | ✅ `assessment-dashboard.html` + `get-dashboard-stats`, con login (14/08/2026) — reemplaza una versión que se rompió con el fix de seguridad del 12/08 |
| **Producto "solo Nivel 1" (`NIVEL1_ONLY`)** | 🟡 Wireado y verificado de punta a punta; bug de scoring de Listening/Reading corregido el 12/08/2026. Encontrado un bug nuevo el 14/08/2026: la ruta puede escapar a OET/STEPS2 si el estudiante saca B2 en todo — ver 6.8 |

## 5. Historial de trabajo reciente

### 10/08/2026

1. **`get-module-progress`**: nueva Edge Function para reanudar un módulo interrumpido (ver 3.3).
2. **Fix de Writing por pista**: `data/nivel1-writing.json` (FULL_360) tenía solo 1 de las 2 tareas cargadas, causando que el módulo mostrara "Tarea 1 de 1" en blanco. Se completó, y se separó `data/nivel1-writing-general.json` para `NIVEL1_ONLY` (solo la tarea general, sin la consigna médica) — mismo patrón que Listening/Reading.
3. **`generate-report` v1**: primera versión, arma el PDF y lo manda a Diana. Invocación solo manual en ese momento (`POST { attempt_id }`).
4. **Fix de GitHub Pages**: un correo de fallo del build de "pages build and deployment" llevó a diagnosticar que Jekyll (el generador de sitios que usa por defecto GitHub Pages) fallaba al intentar una llamada HTTPS interna (error de certificado autofirmado) durante la generación del sitio. Se agregó `.nojekyll` en la raíz del repo, que le dice a GitHub Pages que sirva los archivos tal cual, sin pasar por Jekyll — el build pasó de 21-65 segundos (con Jekyll) a 7 segundos, y de fallar a tener éxito.
5. **`generate-report` v2**: fix de paginación del PDF — una tarjeta de resultado (`.skill-row`) podía cortarse a la mitad entre dos páginas del PDF generado por PDFShift. Se agregaron reglas `page-break-inside`/`break-inside: avoid`.

### 11/08/2026

1. **`register-speaking-booking`**: nueva Edge Function, persiste cada reserva de Speaking en `speaking_assessment_bookings` (antes la tabla existía pero nunca se escribía).
2. **Revisión pedagógica completa de Reading** (informe de Diana): se reescribieron ítems de A1/A2 de `nivel1-reading.json` que en realidad pedían identificar la función gramatical de un conector en vez de comprensión/localización, se moderaron distractores con lenguaje absoluto ("always"/"completely"/"banned"/"solely"), se reemplazó el cognado "indispensable" por "all-important", se parafrasearon respuestas que casi copiaban el texto original, se igualaron longitudes de opciones donde la correcta era obviamente más larga, y se agregó una pista textual para "medication reconciliation". Aplicado en paralelo a `nivel1-reading-general.json` (ítems compartidos entre ambos productos, más los específicos de Speak Easy con el mismo tipo de problema). `nivel1-reading.json` → v4, `nivel1-reading-general.json` → v2. `correct_answer` también se actualizó en Supabase para estos ítems.

### 12/08/2026

1. **Fix de bug en `submit-response`**: `MODULE_TO_SKILL` no mapeaba `nivel1_listening_general`/`nivel1_reading_general` a ningún skill, así que los estudiantes de `NIVEL1_ONLY` nunca generaban `sub_score` de listening/reading (sus respuestas sí se guardaban bien, pero el ceiling CEFR nunca se calculaba). Corregido y verificado end-to-end con una cuenta de prueba desechable antes de dar por cerrado.
2. **Revisión pedagógica completa de Listening** (informe de Diana): en `nivel1-listening.json` (médico) se corrigió Audio 3/Q9 (dependía de encadenar dos cognados en vez de seguir una corrección conversacional, y tenía un error de pronombre), se reformularon las opciones de Audio 4/Q16 y Audio 5/Q17 para sacar el patrón de "etiquetas de tono" (Confident/Alarmed/Cautious) que las hacía adivinables sin escuchar. En `nivel1-listening-general.json` se aplicaron los mismos criterios más ajustes de Audio 1/Q4, Audio 2/Q7, Audio 3/Q11 y Audio 5/Q20 para reforzar anclaje real en el audio. **Q17 (ambos productos) se rediseñó dos veces**: la primera reformulación seguía testeando la postura general del hablante, que el propio audio declara de forma explícita al principio — un desafío directo confirmó que eso es más B2 que C1 según los descriptores CEFR de "identificar pistas e inferir". Se lo volvió a rediseñar para apuntar a una relación genuinamente implícita (la idea de prioridad "eso ni siquiera es el fondo del asunto" en el médico; la asimetría de confianza implícita hacia el algoritmo en el general). `nivel1-listening.json` → v3, `nivel1-listening-general.json` → v3.
3. **`generate-report` v3 + automatización de Speaking**: se construyeron `submit-speaking-score` y `list-pending-speaking-scores` (Edge Functions nuevas) y `admin-speaking-score.html` (página interna nueva, con login propio de Supabase Auth) para que Diana cargue el resultado de Speaking sin editar Supabase Studio a mano. El schema de `evaluator_score` distingue OET (9 criterios oficiales: 4 lingüísticos 0-6 + 5 de comunicación clínica 0-3, más grade general) de English (nivel CEFR de la escalera A1.1-C1.2 + checklist de pronunciación de 17 ítems). `generate-report` se actualizó para mostrar ese desglose en el PDF en vez de un genérico `cefr_estimate`/`comment`. Al guardar el score, se dispara `generate-report` fire-and-forget — como Speaking siempre es el último paso de `FULL_360`, esto en la práctica automatiza el reporte de punta a punta para ese producto (`NIVEL1_ONLY` queda afuera, ver 6.6). Probado de punta a punta con datos desechables (incluyendo rechazo de la clave anon pública) antes de darlo por cerrado.
4. **Corrección de seguridad crítica**: se detectó (alerta del linter de seguridad de Supabase) que la vista `student_progress_summary` tenía `SELECT` otorgado a `anon` y corría con privilegios de superusuario, exponiendo el listado completo de estudiantes —incluyendo `access_code`— a cualquiera con la clave pública del sitio. Corregido de inmediato: se revocó el permiso y se fijó `security_invoker = on`.

### 14/08/2026

1. **Corrección de un error de este documento**: una versión anterior de este brief y del README decía que `NIVEL1_ONLY` "nunca pasa por Speaking" y que por eso no generaba reporte automático. Es incorrecto — Diana señaló que ambas pistas agendan Speaking al final, y se confirmó revisando el código: `get-unlock-state` no distingue `track` en ningún punto, así que un `NIVEL1_ONLY` que termina Nivel 1 sin calificar para STEPS2/OET va derecho a `speaking.html` igual que cualquier estudiante. Como consecuencia, el reporte automático (que se dispara desde `submit-speaking-score`) **ya cubre `NIVEL1_ONLY`** hoy: apenas Diana carga el score de Speaking de uno de estos estudiantes, `generate-report` se dispara, y como para esta pista alcanza con los 4 sub_scores de Nivel 1 (que ya existen), el reporte sale sin esperar nada más. El pendiente 6.6 de este brief (versiones anteriores) quedaba obsoleto por esta razón.
2. **Bug nuevo encontrado, sin corregir todavía**: revisando lo anterior se encontró que la asignación de ruta (`recomputeRouteAndPersist`, duplicada en `submit-response` y `submit-writing`) no tiene en cuenta el `track` del attempt — calcula `OET`/`STEPS2`/`ENGLISH` solo a partir de los 4 niveles CEFR. Un estudiante de `NIVEL1_ONLY` que saque B2 en las 4 destrezas de Nivel 1 quedaría hoy asignado a la ruta OET (o STEPS2) y `get-unlock-state` lo mandaría a `oet-listening.html`/`steps2.html` — módulos con contenido médico que no deberían existir para este producto (la sección 1 de este mismo brief dice que `NIVEL1_ONLY` nunca debería pasar por ahí, "sin importar el resultado"). Sin impacto real todavía: ningún estudiante de `NIVEL1_ONLY` completó Nivel 1 con ese resultado hasta ahora. Ver 6.8.
3. **Dashboard interno de Diana roto por el fix de seguridad — diagnosticado y corregido**: Diana reportó que su archivo local `assessmentdashboardv2_2.html` (nunca vivió en este repo) dejó de traer datos reales, mostrando todo en cero sin ningún error visible. Causa: ese archivo leía `student_progress_summary`, `response_statistics` y `completion_times` directo desde el navegador con la clave pública (`anon key`) — acceso que se cortó a propósito el 12/08/2026 al corregir la fuga de datos de `student_progress_summary` (se le revocó `SELECT` a `anon`/`authenticated`). El archivo no distinguía una respuesta de "permiso denegado" de una lista vacía, así que mostraba ceros en vez de un error. Se construyó una Edge Function nueva, `get-dashboard-stats`, que corre con `service_role` (lee las 3 vistas sin depender de los GRANT de PostgREST) y exige el mismo login real de Supabase Auth que ya usa `admin-speaking-score.html` — así el permiso público sobre esas vistas no se vuelve a abrir. Se reconstruyó el dashboard como `assessment-dashboard.html`, con pantalla de login (misma cuenta que `admin-speaking-score.html`) delante del contenido. No se pudo probar el flujo de login → datos de punta a punta en esta sesión (el entorno de Claude no tiene salida de red directa a la API de Supabase para simular el navegador); el patrón de autenticación es una copia exacta del ya probado en `submit-speaking-score`/`list-pending-speaking-scores`, pero conviene que Diana confirme el login la primera vez que abra el archivo nuevo.

---

## 6. Pendientes conocidos (no bloqueantes)

### 6.1 ✅ `get-unlock-state` y `register-student` — resuelto

Ya están sincronizadas en `supabase/functions/` junto con el resto.

### 6.2 🟡 Módulos "archivo" sin borrar en `question_bank`

`nivel1_grammar_archivo` (24), `nivel1_listening_archivo` (34) y `nivel1_reading_archivo_v1` (12) son versiones de contenido reemplazadas que quedaron en la tabla sin usar. No rompen nada, pero conviene limpiarlas en algún momento.

### 6.3 ✅ Writing por pista — resuelto (10/08/2026)

Ver historial, sección 5.

### 6.4 ✅ Reserva de Speaking sin persistir — resuelto (11/08/2026)

Ver historial, sección 5.

### 6.5 🟡 Estructura de carpetas de 3 Edge Functions nuevas

`submit-speaking-score`, `list-pending-speaking-scores` y `generate-report` quedaron subidas al repo como archivo suelto en `supabase/functions/` (ej. `supabase/functions/generate-report`, sin carpeta ni `index.ts`), a diferencia de todas las demás funciones que siguen `supabase/functions/<nombre>/index.ts`. El contenido es idéntico a lo desplegado (verificado byte a byte), así que no afecta lo que corre hoy en producción — pero si en algún momento se usa `supabase functions deploy` o cualquier herramienta que espere la convención de carpetas, va a fallar con estas tres. Se corrige renombrando cada archivo a `supabase/functions/<nombre>/index.ts` (se puede hacer desde la interfaz web de GitHub, con "rename" a la ruta completa).

### 6.6 ✅ `generate-report` y `NIVEL1_ONLY` — resuelto (era un malentendido, no un bug)

Versiones anteriores de este brief decían que `generate-report` no cubría `NIVEL1_ONLY` porque esa pista "nunca pasa por Speaking". Es incorrecto: `NIVEL1_ONLY` sí agenda y rinde Speaking igual que `FULL_360` (ver 5, 14/08/2026), así que el mismo disparador (`submit-speaking-score` → `generate-report`) ya cubre las dos pistas. No hace falta conectar nada nuevo.

### 6.7 🟡 Otros detalles menores

- Ningún estudiante real (de los 11 cargados) completó un attempt todavía — la única fila en `attempts` es de una cuenta de prueba.
- `test-flow.mjs` (Playwright) solo cubre login → intake; no se actualizó para cubrir Listening/Reading, `NIVEL1_ONLY`, ni el flujo de Speaking/reporte.
- 6 advertencias de seguridad de severidad baja (`search_path` mutable en funciones internas como `get_student_info` y varios triggers `populate_name`) quedaron anotadas por Diana para revisar más adelante — no son una fuga de datos, son buena práctica de Postgres.

### 6.8 🟡 NUEVO (14/08/2026) — `NIVEL1_ONLY` puede escapar a la ruta OET/STEPS2

`recomputeRouteAndPersist` (duplicada en `submit-response` y `submit-writing`) asigna la ruta del Nivel 1 solo mirando los 4 niveles CEFR, sin mirar `track`. Un estudiante `NIVEL1_ONLY` con B2 en las 4 destrezas terminaría hoy en la ruta OET (o STEPS2), con contenido médico que no le corresponde a este producto. Fix sugerido: en las dos funciones, si `track === 'NIVEL1_ONLY'`, forzar `assignedRoute = 'ENGLISH'` (y `speakingAssessmentType = 'English'`) sin evaluar los niveles CEFR, sin importar el resultado — que es exactamente lo que dice la sección 1 de este brief que debería pasar. Sin impacto real todavía (ver 6.7 — nadie completó un attempt real de `NIVEL1_ONLY`).

---

## 7. Backlog priorizado (sugerido)

1. Corregir el bug de asignación de ruta en `NIVEL1_ONLY` (ver 6.8) — antes de que el primer estudiante real de esta pista saque B2 en todo.
2. Corregir la estructura de carpetas de las 3 Edge Functions nuevas (ver 6.5) — dejado pendiente a pedido de Diana por ahora.
3. Confirmar en producción el login de `assessment-dashboard.html` (Edge Function nueva, no se pudo probar de punta a punta desde esta sesión — ver 5, 14/08/2026).
4. Revisar las 6 advertencias de seguridad de severidad baja (`search_path` mutable, ver 6.7).
5. Limpiar los módulos "archivo" de `question_bank` (ver 6.2).
6. Definir si un estudiante puede reintentar el assessment completo (hoy no existe mecanismo de reintento).
7. Actualizar `test-flow.mjs` para cubrir Listening/Reading, `NIVEL1_ONLY` y el flujo de Speaking/reporte.

---

## 8. Notas técnicas para la próxima sesión

- El patrón correcto para cualquier módulo nuevo de examen es el que usa Listening/Reading: el frontend nunca calcula si algo es correcto, siempre llama a `submit-response` con `session_token` + `question_id` + `selected_answer`, y la Edge Function hace todo el trabajo (calificar, guardar, y si el módulo se completa, recalcular `sub_scores` y la ruta).
- Cuando se agrega contenido nuevo que debe convivir con uno existente sin mezclarse en el conteo de "módulo completo", usar un `module` (string) separado en `question_bank`/`audio_assets`, y extender `MODULE_TO_SKILL` en `submit-response` (y el mapa equivalente en `get-module-progress`) para que apunte al mismo `skill` — nunca reutilizar el mismo nombre de módulo para dos sets de contenido distintos. El bug del 12/08/2026 (sección 5) fue exactamente esto: se agregó el módulo pero se olvidó extender `MODULE_TO_SKILL`.
- `sessionStorage.cp360_track` decide branding y qué contenido pedir en el navegador; `attempts.track` (columna en Supabase) es la fuente de verdad server-side para decidir la ruta — hay que mantener los dos en sync desde `login`, pero son cosas distintas y no intercambiables.
- Todas las claves usadas en el frontend público (`SUPABASE_ANON_KEY`) son la clave **anon/publishable**, no la `service_role` — está bien que estén hardcodeadas en el JS público, es el diseño intencional. Lo que **no** está bien es dar permisos de lectura directa sobre datos de estudiantes a esa clave sin pasar por RLS o una Edge Function — ver el incidente de `student_progress_summary` (sección 5). Cualquier vista o tabla nueva expuesta a `anon`/`authenticated` hay que revisarla explícitamente.
- Patrón de autenticación para herramientas internas (no estudiantes): `admin-speaking-score.html` usa un login real de Supabase Auth (email/password vía `/auth/v1/token?grant_type=password`), distinto del sistema de `access_code` + `session_token` que usan los estudiantes. Las Edge Functions que la sirven (`submit-speaking-score`, `list-pending-speaking-scores`) validan explícitamente que el token recibido sea de un usuario autenticado real (`auth.getUser()`), no la anon key — porque `verify_jwt: true` en la configuración de la función acepta *cualquier* JWT válido del proyecto, incluida la anon key pública, así que no alcanza por sí solo para restringir el acceso a Diana.
- Cualquier lógica que dependa del resultado del estudiante (como `recomputeRouteAndPersist`) y conviva con más de un `track` tiene que decidir explícitamente qué pasa en cada `track` — no asumir que la fórmula genérica ya excluye correctamente a la pista que no debería verse afectada. El bug de la sección 6.8 es exactamente esto: se agregó `NIVEL1_ONLY` a la sección 1 del brief como "nunca pasa por STEPS2 ni OET, sin importar el resultado", pero el código que asigna la ruta nunca se actualizó para reflejar esa regla.
- Esta sesión no tiene salida de red directa hacia la API pública de Supabase (ni hacia otros dominios fuera de una lista permitida) — `curl`/`fetch` a `https://qqdxmmvhthwcqhgmvyic.supabase.co/...` falla en el proxy de la sandbox. Las herramientas de Supabase (MCP) sí funcionan porque no pasan por ese proxy. Esto significa que una Edge Function nueva se puede desplegar y su lógica se puede razonar con confianza (comparándola con un patrón ya probado en producción), pero un test end-to-end real vía HTTP (como el que sí se pudo hacer para `submit-speaking-score` en una sesión anterior) puede no ser posible siempre — hay que decírselo a Diana explícitamente en vez de asumir que quedó probado.
- Este repositorio (`SpeakEasyLat/clearpath-assessment-360`) permite lectura desde sesiones de Claude en la nube, pero **no** push directo — los cambios de código de una sesión en la nube hay que entregárselos a Diana como archivos para que los suba ella misma vía GitHub (editar/reemplazar archivo o "Add file → Upload files"), no asumir que un `git push` va a funcionar. Los cambios directos a Supabase (Edge Functions, tablas, RLS, `question_bank`) sí se pueden aplicar en vivo desde la sesión, vía las herramientas de Supabase — no dependen de que Diana suba nada.
