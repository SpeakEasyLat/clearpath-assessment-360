# Brief — ClearPath Assessment 360

**Actualizado:** 31 de agosto de 2026 (se generalizó la regla de "rescate" de OET — antes solo existía para Listening con un umbral fijo de 75% en la banda B2, ahora aplica igual a Grammar/Listening/Reading vía `highestPassingBand`, y la regla de desbloqueo de OET pasó de exigir las 4 destrezas de Nivel 1 en B2+ a exigir al menos 3 de 4, con la restante en al menos B1 — pedido explícito de Diana a partir del caso de Luis Padilla. Ver sección 3.4/3.5 y el historial del 31/08/2026 en sección 5)

**Versión anterior:** 24 de agosto de 2026 (se unificó este documento con `BRIEF_2.md`, un archivo duplicado que había quedado subido el 21/08 sin fusionar con `BRIEF.md` — mismo patrón de duplicado que ya había pasado el 14/08 con `BRIEF_1.md`, ver sección 5. Se agregó todo el trabajo del 21 al 24/08/2026 que no estaba documentado en ninguna versión: la reescritura grande de `generate-report` -v7 a v13-, el rescate de OET para Listening, el fix del "duda favorece al estudiante" en Writing, el reporte PARCIAL nuevo -`generate-partial-report`- y una rúbrica de calificación detallada -sección 3.5, nueva-. Más tarde ese mismo día se agregó también el rediseño completo del banco de STEP CK 2 -de 8 a 16 preguntas, de conocimiento clínico a lectura en inglés- ver sección 5, 24/08/2026 "tarde")
**Preparado por:** Claude, a partir de la revisión completa del repositorio (`SpeakEasyLat/clearpath-assessment-360`), la base de datos y las Edge Functions de Supabase (proyecto `qqdxmmvhthwcqhgmvyic`), y del historial de esta conversación.

> **Nota sobre el alcance de este brief:** no tengo forma de leer conversaciones de otras sesiones de chat fuera de esta. Este documento se armó revisando el estado *real* de las cosas — el código del repositorio, el esquema y los datos actuales de Supabase, y las Edge Functions desplegadas — en vez de basarme solo en lo que se haya dicho en el chat. Reemplaza por completo la versión del 8 de agosto de 2026.

---

## 1. Qué es el proyecto

Assessment 360 es una plataforma de evaluación de inglés para Speak Easy. Hoy conviven **dos productos** sobre la misma base de código y el mismo backend:

- **`FULL_360`** (producto original, pista por defecto): pensado para médicos que preparan el examen OET dentro del pathway ABR de radiología. Recorrido completo:

  **English Level (Nivel 1) → STEPS 2 *o* OET Skills, según el resultado → Speaking Assessment (sesión en vivo)**

  con desbloqueo adaptativo según el desempeño del estudiante y audios de reproducción limitada imitando el formato real del examen OET.

- **`NIVEL1_ONLY`** (agregado 07-08/08/2026): un segmento de estudiantes de público general que rinde **únicamente** Nivel 1 — English Level, sin pasar nunca por STEPS 2 ni OET, sin importar el resultado. Entra por una puerta separada (`index-nivel1.html`) y usa contenido de Listening/Reading no médico, ya que estos estudiantes no son necesariamente profesionales de la salud.

Desde el 12/08/2026, el resultado final de cada assessment (todas las skills) se arma automáticamente en un PDF y se manda por correo a Diana apenas queda completo — antes esto se revisaba solo por consulta SQL directa. Desde el 24/08/2026, además, se manda un reporte **parcial** apenas termina la parte escrita (Nivel 1 + STEPS2/OET si aplica), sin esperar a Speaking — ver sección 5 (24/08/2026) y 3.3 (`generate-partial-report`).

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
                       subidas como archivo suelto (sin carpeta) — pendiente de corregir, ver 6.5. Además,
                       generate-partial-report, send-incomplete-assessment-reminder, send-assessment-reminders,
                       get-dashboard-stats, debug-signed-audio-url y test-grade-b2 están desplegadas en Supabase
                       pero NO tienen ningún archivo en el repo todavía — ver 6.9.
supabase/migrations/ → migraciones SQL (esquema inicial + ajustes posteriores)
CNAME → assessment.speakeasy.lat
```

### 3.2 Base de datos (Supabase, esquema actual en producción — filas al 24/08/2026)

| Tabla | Filas hoy | Para qué sirve |
|---|---|---|
| `students` | 20 | Estudiantes, con `access_code` único que Diana genera a mano (o que emite `register-student`) tras confirmar el pago |
| `attempts` | 7 (5 `completed`, 3 de pista `NIVEL1_ONLY`) | Una corrida completa del Assessment 360. Tiene `track` (`FULL_360` default / `NIVEL1_ONLY`), `report_sent_at` (reporte final ya mandado) y, desde el 24/08/2026, `partial_report_sent_at` (reporte parcial —sin Speaking— ya mandado, ver 3.3 `generate-partial-report`) |
| `question_bank` | 232 | Banco de preguntas de todos los módulos. Incluye módulos activos y algunos "archivo" (versiones viejas de Listening/Reading/Grammar que se reemplazaron pero se dejaron sin borrar — ver detalle abajo) |
| `student_responses` | 380 | Respuestas guardadas server-side, con `is_correct` calculado por `submit-response` |
| `sub_scores` | 23 | Ceiling CEFR (o pass/fail para STEP CK 2, o puntaje informativo para OET) por habilidad. `band_detail` (jsonb) ahora también guarda `oet_effective_level` (banda más alta aprobada con ≥70%, aunque no sea el ceiling) y, cuando corresponde, `oet_unlock_override`/`oet_unlock_note` — desde el 31/08/2026 para Grammar, Listening y Reading (antes solo Listening) — ver 3.4 y 3.5 |
| `unlock_state` | 7 | Ruta asignada (`OET`/`STEPS2`/`ENGLISH`), si se desbloqueó STEPS2/OET, y qué tipo de Speaking Assessment corresponde |
| `audio_assets` | 21 | Metadata de los audios de Listening (`storage_path`, `max_plays`, `module`) |
| `audio_play_log` | — | Registro de reproducciones ya usadas, para hacer cumplir `max_plays` |
| `writing_prompts` | 2 | Consignas de Writing: `nivel1_writing` (1) y `oet_writing` (1) — no existe variante `_general`, ambos productos comparten la misma consigna de Nivel 1 |
| `writing_submissions` | 5 | Texto de cada tarea de Writing + calificación de IA (`ai_rubric_scores`, `cefr_estimate`) — desde el 22/08/2026 `ai_rubric_scores` también incluye `correcciones_para_b2` (ver 3.5) |
| `speaking_assessment_bookings` | 2 (1 con `evaluator_score` cargado) | Reserva de la sesión en vivo (desde 11/08/2026 se escribe de verdad, ver 5) + `evaluator_score` (jsonb) con el resultado que carga Diana desde `admin-speaking-score.html` (desde 12/08/2026) |
| `attempt_sessions` | — | Tokens de sesión (expiran 4 h después del login) |
| `intake_responses` | — | Respuestas del formulario previo (no calificado) |
| `assessment_reminders` | — | Recordatorios a estudiantes que nunca loguearon (`send-assessment-reminders`, 19/08/2026) — no está en este repo, ver 6.9 |
| `incomplete_assessment_reminders` | — | NUEVO (22/08/2026): recordatorios a estudiantes que sí loguearon pero no terminaron (`send-incomplete-assessment-reminder`) — un solo correo por `attempt_id`, disparado cuando vence la sesión sin que el estudiante haya vuelto. No está en este repo, ver 6.9 |

De estos 5 `attempts` completados, 3 ya recibieron el reporte final (`report_sent_at`) y los 3 que llegaron a completar la parte escrita recibieron también el reporte parcial (`partial_report_sent_at`) — ver sección 5 (24/08/2026).

Desglose de `question_bank` por módulo (240 filas totales — sube de 232 el 24/08/2026 "tarde" por el rediseño de `steps2`, ver 5):

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
| `steps2` | 16 | solo ruta STEPS2 — subió de 8 el 24/08/2026 "tarde", ver 5 |

Los módulos "archivo" siguen sin usarse y sin borrar (ver backlog, sección 7).

Row Level Security está habilitado en todas las tablas. El frontend público nunca lee `correct_answer` directamente; todo pasa por Edge Functions con `service_role`.

**Vista `student_progress_summary`:** existe una vista de conveniencia (creada fuera de este flujo de trabajo, no vive en las migraciones del repo) que junta `students` + `attempts` + `unlock_state` + `sub_scores` + `speaking_assessment_bookings` para consulta rápida. El 12/08/2026 se detectó que tenía `SELECT` otorgado al rol `anon` y corría con privilegios de superusuario (comportamiento por defecto de las vistas en Postgres, equivalente a `SECURITY DEFINER`), lo que permitía leer el listado completo de estudiantes —incluyendo `access_code`— con solo la clave pública del sitio, sin pasar por RLS. Se corrigió: se le revocó `SELECT` a `anon`/`authenticated` y se le fijó `security_invoker = on`. No se usa desde ninguna pantalla del sitio, así que no hay impacto funcional.

Storage: bucket privado `audio-assets`, cero políticas de acceso directo para `anon`/`authenticated` — las URLs firmadas las emite `get-audio-url`.

### 3.3 Edge Functions desplegadas

| Función | Qué hace |
|---|---|
| `login` | Valida `access_code` contra `students`, crea/retoma `attempt` (fija `track` solo al crear uno nuevo), emite `session_token` (expira en 4 h). Acepta `track: 'NIVEL1_ONLY'` en el body; default `FULL_360` |
| `submit-intake` | Guarda el formulario previo (no calificado) |
| `submit-response` | v33. Corrige la respuesta server-side (multiple_choice o note_completion), la guarda, y si con eso se completa el módulo calcula el sub_score y recalcula la ruta del Nivel 1. **Fix 12/08/2026:** `MODULE_TO_SKILL` no incluía `nivel1_listening_general`/`nivel1_reading_general`. **v20 (23-24/08/2026):** agrega el rescate de OET para Listening (`LISTENING_B2_RESCUE_THRESHOLD`) — ver 3.5. Ahora también dispara `generate-partial-report` fire-and-forget en cuanto marca el attempt `completed`. **v32 (24/08/2026 "tarde", solo comentario, sin cambio funcional):** documenta el rediseño de `steps2` junto a `STEPS2_PASS_THRESHOLD`. **v33 (31/08/2026, caso de Luis Padilla):** generaliza el rescate a Grammar/Listening/Reading (`highestPassingBand` reemplaza `LISTENING_B2_RESCUE_THRESHOLD`) y cambia la regla de desbloqueo de OET de "4 de 4 skills en B2+" a "al menos 3 de 4, con la restante en al menos B1" (`MIN_LEVEL_FLOOR_FOR_OET`) — ver 3.4/3.5. **El repo vuelve a quedar desactualizado respecto a este deploy** — ver 6.9 |
| `get-audio-url` | Valida sesión + `max_plays`, emite URL firmada, registra la reproducción |
| `submit-writing` | v35. Guarda cada tarea de Writing, la califica con IA (rúbrica de placement 0-10 combinada con CEFR — ver 3.5), escribe `sub_scores` y recalcula la ruta (lógica duplicada intencionalmente respecto a `submit-response` — mantener sincronizadas). **v17-v19 (21-22/08/2026):** feedback de la IA en español, y nuevo campo `correcciones_para_b2` (hasta 7 ítems). **v9-v10 (23-24/08/2026, caso de Paula):** fuerza en código el nivel alto cuando la IA marca `borderline_decision` pero no lo aplicaba ella sola — ver 3.5. También dispara `generate-partial-report` al completar la parte escrita. **v35 (31/08/2026):** replica en `recomputeRouteAndPersist` la misma regla nueva de 3-de-4 skills que `submit-response` v33 (Writing no tiene bandas propias, así que solo cambia la función de ruteo compartida) |
| `get-unlock-state` | Le dice a `siguiente.html` a qué pantalla mandar al estudiante según los sub_scores/ruta ya calculados |
| `get-module-progress` | NUEVO (10/08/2026): devuelve qué preguntas de un módulo de opción múltiple ya tienen respuesta guardada, para que el frontend pueda reanudar un módulo interrumpido en vez de reiniciarlo desde la pregunta 1 |
| `register-student` | Crea un estudiante nuevo con `access_code` único (`CP-XXXXXX`) a partir del formulario de intake de RPS (Google Forms → Apps Script), y le envía el código por correo |
| `register-speaking-booking` | NUEVO (11/08/2026): persiste en `speaking_assessment_bookings` cada clic en "Agendar" en `speaking.html` — antes esa tabla existía pero nunca se insertaba nada ahí. Idempotente por `attempt_id`, fire-and-forget (no bloquea la redirección a Calendar) |
| `generate-report` | v21. Arma el PDF de resultados FINAL (con Speaking) y lo manda por correo a Diana vía Resend cuando el assessment queda completo (idempotente vía `attempts.report_sent_at`). Cambios grandes 21-22/08/2026 (v7 a v13): Speaking en las dos pistas, "Resultados por destreza" antes del resumen global, nivel funcional como rango de las 2 destrezas más bajas, filas con la escala nativa de OET/STEPS2, y `correcciones_para_b2` en la tarjeta de Writing — ver 3.5 y 5 para el detalle versión por versión. **v21 (31/08/2026):** generaliza `oet_unlock_note` — antes solo se mostraba para Listening (`sk === "listening"`), ahora se muestra para cualquier skill que haya tenido rescate. **El código de este archivo en el repo está desactualizado respecto a lo desplegado** — ver 6.9 |
| `generate-partial-report` | v9. Función hermana de `generate-report`, agregada el 24/08/2026: arma y manda el mismo tipo de PDF pero **parcial** (sin Speaking), apenas `attempts.status` pasa a `completed` — es decir, apenas termina la parte escrita. Idempotente vía `attempts.partial_report_sent_at`, totalmente independiente del reporte final. Incluye una integración opcional con Google Drive (sube el PDF a una carpeta compartida vía cuenta de servicio con domain-wide delegation) que hoy está inactiva porque faltan cargar los secrets `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_DRIVE_FOLDER_ID` — ver 6.10. **v9 (31/08/2026):** mismo cambio que `generate-report` v21, generaliza `oet_unlock_note` a cualquier skill. No está en el repo todavía (ver 6.9) |
| `submit-speaking-score` | NUEVO (12/08/2026): guarda el `evaluator_score` que Diana carga desde `admin-speaking-score.html`, valida que el schema corresponda al tipo de reserva (OET o English) y dispara `generate-report` fire-and-forget. Exige un token de sesión real de Supabase Auth — rechaza explícitamente la clave anon pública |
| `list-pending-speaking-scores` | NUEVO (12/08/2026): lista las reservas de Speaking sin `evaluator_score` cargado todavía, para el selector de `admin-speaking-score.html`. Misma validación de sesión que `submit-speaking-score` |
| `get-dashboard-stats` | NUEVO (14/08/2026), no está en el repo todavía (ver 6.9): devuelve `student_progress_summary` + `response_statistics` + `completion_times` para `assessment-dashboard.html`. Corre con `service_role` y exige el mismo login real de Supabase Auth que `submit-speaking-score` |
| `send-assessment-reminders` | NUEVO (19/08/2026), no está en el repo todavía (ver 6.9): recordatorio por correo a estudiantes que nunca crearon un `attempt` (nunca loguearon), a los 3/10/17 días de creados. Cron diario (`pg_cron`) |
| `send-incomplete-assessment-reminder` | **NUEVO (22/08/2026)**, no está en el repo todavía (ver 6.9): recordatorio a estudiantes que sí loguearon pero dejaron el assessment a medias (`status='in_progress'`, sesión ya vencida) — un solo correo por `attempt_id`, con su código de acceso para retomar. Excluye a quien ya tiene otro attempt `completed` (evita el falso positivo de un "attempt fantasma" que crea `login` si alguien vuelve a entrar después de terminar). Cron horario |
| `debug-anthropic` / `debug-signed-audio-url` / `test-grade-b2` | Utilidades internas de diagnóstico (probar la API de Anthropic, generar una URL firmada de audio, probar la calificación de Writing). No forman parte del flujo del estudiante; las dos últimas tampoco están en el repo (ver 6.9) |

### 3.4 Algoritmo de scoring y reglas de desbloqueo

- **Ceiling CEFR por banda** (`js/scoring.js` y replicado en `submit-response`/`submit-writing`): para cada módulo tipo "escalera" (grammar, listening, reading), se sube de A1 en adelante mientras cada banda CEFR supere el 70% de acierto. En cuanto una banda no llega al umbral, ahí se corta el ceiling.
- **STEP CK 2**: pass/fail puro (≥75% para aprobar), sin bandas CEFR — sus preguntas tienen `cefr_level = null`. El umbral es un porcentaje, no un conteo fijo (`totalInModule`/`moduleQuestionIds` se leen de `question_bank` en runtime en `submit-response`), así que el rediseño del 24/08/2026 "tarde" que pasó el banco de 8 a 16 preguntas no requirió ningún cambio de lógica — 12/16 sigue siendo el mismo 75% que antes era 6/8. Ver 5.
- **OET Listening/Reading**: puntaje informativo únicamente (raw_score/max_score), sin banda ni aprobar/reprobar — estos estudiantes ya calificaron para OET en Nivel 1.
- **"Nivel efectivo" por destreza (`highestPassingBand`, NUEVO 31/08/2026, reemplaza el rescate de solo-Listening):** para grammar, listening y reading, además del ceiling bottom-up de siempre, se calcula el **nivel efectivo**: la banda CEFR **más alta** (A1→C1) que el estudiante aprobó con ≥70%, revisando TODAS las bandas sin cortar en la primera que falla. Si esa banda efectiva queda por encima del ceiling, se guarda `band_detail.oet_effective_level` y una nota legible (`band_detail.oet_unlock_note`) explicando el traspié — igual que antes, pero ahora para cualquiera de las 3 destrezas tipo "escalera", no solo Listening. **El nivel CEFR mostrado (ceiling) nunca cambia** — el nivel efectivo solo se usa para decidir elegibilidad a OET/STEPS2, nunca para lo que ve el estudiante o lo que se muestra como "nivel general" en el reporte.
- **Ruta del Nivel 1** (pista `FULL_360`, tres ramas mutuamente excluyentes, se calcula recién cuando existen los 4 sub_scores de Nivel 1 — grammar, listening, writing, reading), **regla nueva desde el 31/08/2026 (antes exigía las 4 en B2+, ver historial):**
  - Se toma el **nivel efectivo** de cada una de las 4 destrezas (`oet_effective_level` si existe, si no el ceiling normal).
  - Si **al menos 3 de las 4** llegan a B2+ **Y las 4** llegan al menos a B1 (`MIN_LEVEL_FLOOR_FOR_OET`, evita que una destreza genuinamente floja en A1/A2 quede compensada por las otras tres) → ruta **OET**.
  - Si no, pero reading llega a B2 → ruta **STEPS2**.
  - Si reading tampoco llega → ruta **ENGLISH**.
- **Pista `NIVEL1_ONLY`**: en cuanto están los 4 sub_scores de Nivel 1, la ruta queda **siempre** en `ENGLISH` (Speaking Assessment breve tipo English), sin evaluar los sub_scores — sin importar el resultado (así lo dice la sección 1). `recomputeRouteAndPersist` (en `submit-response`/`submit-writing`) lee `attempts.track` explícitamente para esto desde el 14/08/2026 — antes de ese fix, calculaba la ruta solo a partir de los 4 niveles CEFR sin mirar el track, así que un estudiante `NIVEL1_ONLY` con B2 en las 4 destrezas hubiera quedado asignado a `OET`/`STEPS2` igual que uno de `FULL_360` (bug encontrado y corregido el mismo día, ver 6.8; sin impacto real porque nadie lo pisó antes del fix).
- **Historia del mecanismo de "rescate" — de solo-Listening a regla general:** el 23-24/08/2026, a pedido de Diana por el caso de Juan Sebastián, se agregó `LISTENING_B2_RESCUE_THRESHOLD`: si el patrón de Listening quedaba "inconsistente" (superaba alguna banda POR ENCIMA de donde se cortó el ceiling) pero sacaba ≥75% específicamente en la banda B2, igual se desbloqueaba OET para esa destreza — solo Listening, y solo mirando la banda B2. El 31/08/2026, a partir del caso de Luis Padilla (que superó C1 en Listening con un 75% real pero había fallado B2, y cuyo perfil global — 3 destrezas fuertes y una floja — no encajaba en la regla de "las 4 en B2+"), Diana pidió generalizar el mecanismo: reemplazar el umbral fijo de Listening/B2 por `highestPassingBand` (cualquier banda, cualquiera de las 3 destrezas tipo escalera) y cambiar la regla de desbloqueo de "4 de 4" a "3 de 4 con piso B1". Ver 3.5 para el detalle completo y el historial (sección 5, 31/08/2026) para el caso concreto.
- Esta lógica (incluida la regla de 3-de-4 y `highestPassingBand`) está **triplicada intencionalmente** en `js/scoring.js` (preview client-side), `submit-response` y `submit-writing`. Si se cambia algún umbral, hay que tocar los tres lugares.
- `detectPatternInconsistency()` deja registrado en `sub_scores.band_detail` si el patrón de aciertos por banda es inconsistente (ej. falla B1 pero aprueba B2) — sigue siendo solo diagnóstico; `oet_effective_level`/`oet_unlock_note` es lo que efectivamente alimenta la elegibilidad a OET.
- **Nivel CEFR general del reporte** (`generate-report`/`generate-partial-report`): desde el 21/08/2026 (v8) ya no es un solo nivel sino el **rango** entre las dos destrezas de Nivel 1 con el resultado más bajo (ej. "A1-A2"); si las dos coinciden, se muestra un solo nivel. No incluye Speaking, OET ni STEPS2 en ese cálculo — esos se muestran aparte, con su propia escala (ver 3.5).
- Cubierto por 7 casos de test en `js/scoring.test.mjs` (`node js/scoring.test.mjs`) — **ojo:** estos tests no se actualizaron todavía para cubrir el rescate de Listening (23-24/08/2026), ver backlog, sección 7.

### 3.5 Rúbrica de calificación

**Writing (Nivel 1 y OET) — `submit-writing`, calificado por IA (Claude), rúbrica `cefr-anchored-v10-borderline-note`:**

- **Framework A — Placement band (entero 0-10):** juicio holístico sobre 6 cualidades: desarrollo del tema, claridad de propósito, organización, control del lenguaje, precisión (accuracy) y rango (vocabulario/estructuras). Se guarda como `ai_rubric_scores.placement_band`.
- **Framework B — Nivel CEFR (A1-C1):** anclado a los descriptores oficiales del CEFR (range, precisión gramatical, control de vocabulario, coherencia/cohesión, producción escrita general) — el prompt reproduce el texto oficial de cada descriptor para que la IA no use "impresión general".
- **Regla de frontera B1/B2** (la que decide si el estudiante entra a la ruta OET): se otorga B2 solo si las 3 son ciertas — hay formas de oración complejas controladas, los errores son NO sistemáticos, y el texto forma un discurso coherente (no una lista lineal de puntos). Se otorga B1 si CUALQUIERA de estas es cierta: errores sistemáticos, influencia pervasiva de la lengua materna, discurso lineal, o formas complejas intentadas pero no controladas. Advertencia explícita en el prompt: 2-3 errores aislados en un texto por lo demás controlado son "slips" normales de B2, no motivo para bajar a B1.
- **"La duda favorece al estudiante" (regla de Diana, 26/07/2026):** cuando la evidencia queda genuinamente repartida entre dos niveles contiguos, se asigna el ALTO. **v9-v10 (23-24/08/2026, bug real — caso de Paula):** hasta esta fecha, la regla dependía de que la IA la aplicara sola dentro del prompt — y en el caso de Paula, la IA marcó `borderline_decision: true`, `borderline_between: "B1/B2"`, pero igual devolvió B1, dejándola afuera de OET sin motivo. Ahora el nivel alto se **fuerza en el código** (no depende de que el modelo lo haga bien), y además queda una nota visible en el comentario del reporte ("este resultado quedó entre los niveles B1 y B2... se asignó B2, pero conviene seguir reforzando").
- **"Correcciones para llegar a B2" (`correcciones_para_b2`, NUEVO 21-22/08/2026):** lista corta (hasta 7 ítems, subido de 5 el 22/08/2026) de errores de gramática/estructura concretos tomados del propio texto del estudiante, cada uno con su corrección y una explicación breve en español de la regla involucrada. Vive en `ai_rubric_scores`, no se le muestra al estudiante en vivo — se usa en el reporte (tarjeta de Writing de Nivel 1, ver `generate-report` v13 / `generate-partial-report`). Si el texto ya está sólido en B2+, la lista puede venir vacía.
- El **word count sugerido no es criterio de calificación** (decisión de Diana, 05/08/2026) — se califica el nivel de idioma de lo que efectivamente escribió el estudiante, sin penalizar por longitud.
- Todo el feedback de la IA (los 6 comentarios, la justificación CEFR, el comentario general y las explicaciones de `correcciones_para_b2`) se pide en español latinoamericano, tuteo, desde el 21/08/2026 (v17) — antes todo el prompt y la respuesta eran en inglés. Las citas textuales del propio texto del estudiante nunca se traducen.

**OET Speaking (carga manual de Diana en `admin-speaking-score.html`):** 9 criterios oficiales — 4 lingüísticos (Intelligibility, Fluency, Appropriateness of Language, Resources of Grammar and Expression) puntuados 0-6, y 5 de comunicación clínica (Relationship Building, Understanding and Incorporating the Patient's Perspective, Providing Structure, Information Gathering, Information Giving) puntuados 0-3, más un `overall_grade` (A/B/C+/C/D/E). Es el único componente donde el grade OET es real, no aproximado.

**Puntaje OET aproximado (Listening/Reading/Writing, `generate-report`/`generate-partial-report` v9, 21/08/2026):** estos módulos de Nivel 1/OET son diagnósticos propios de Speak Easy, no el banco oficial de OET, así que el reporte muestra una aproximación, no un puntaje oficial:
  - OET Listening / OET Reading: % de aciertos escalado linealmente a 0-500 (`percent * 5`), mapeado al rango de grade oficial más cercano.
  - OET Writing: el `cefr_estimate` (A1-C1) se convierte al rango OET más cercano vía una tabla de aproximación.
  - Rangos oficiales verificados el 21/08/2026 contra `geniusclass.co.uk/oet-calculator` (escala 0-500 vigente desde septiembre 2018):

    | Grade | Rango |
    |---|---|
    | A | 450–500 |
    | B | 350–440 |
    | C+ | 300–340 |
    | C | 200–290 |
    | D | 100–190 |
    | E | 0–90 |

**"Unlock" para OET — resumen de las 3 puertas que hay que cruzar:**

1. **Nivel 1 completo con al menos 3 de los 4 skills en B2+** (grammar, listening, writing, reading), y el 4to skill restante en al menos B1 (`MIN_LEVEL_FLOOR_FOR_OET`) — regla nueva desde el 31/08/2026, ver 3.4. Cada skill usa su **nivel efectivo** (`highestPassingBand`, la banda más alta aprobada con ≥70%, no necesariamente el ceiling) si tuvo un traspié puntual en una banda intermedia.
2. **Writing debe llegar a B2** (o, si no, contar como el único de los 4 que queda por debajo de B2+ dentro de la regla de arriba) vía la rúbrica de abajo — incluida la regla de "la duda favorece al estudiante", ahora forzada en código.
3. Una vez asignada la ruta OET, el estudiante rinde OET Listening/Reading/Writing (informativo, no vuelve a decidir nada) y agenda el Speaking Assessment tipo OET — cuyo grade real lo carga Diana.

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
| **STEPS 2** (solo ruta STEPS2, pista `FULL_360`) | ✅ Completo: 16 preguntas (8 viñetas clínicas × gist + vocabulario en contexto), timer 30 min, pass/fail ≥75% — rediseñado el 24/08/2026 "tarde" (ver 5), antes eran 8 preguntas de conocimiento clínico y 15 min |
| **OET Skills** (solo ruta OET, pista `FULL_360`) | ✅ Completo: Listening (22 preguntas, 3 partes), Reading (16 preguntas, 3 partes), Writing con calificación por IA |
| **Speaking Assessment** | ✅ Agenda + reserva persistida (`speaking_assessment_bookings`) + carga de resultado por Diana (`admin-speaking-score.html`) + reporte automático al completarse. Aplica a las dos pistas (`FULL_360` y `NIVEL1_ONLY`). Cuenta de login de Diana ya creada (13/08/2026) |
| **Reporte de resultados** | ✅ Automático para `FULL_360` y `NIVEL1_ONLY`. **Final** (`generate-report`, con Speaking): se dispara al cargar el score de Speaking. **Parcial** (`generate-partial-report`, NUEVO 24/08/2026): se dispara apenas termina la parte escrita, sin esperar a Speaking. Ambos son PDF por correo a Diana (nunca al estudiante), idempotentes, y comparten casi todo el armado — ver 3.3, 3.5 y 5 |
| **Recordatorios automáticos** | ✅ Dos sistemas por correo (Resend + `pg_cron`): a quien nunca logueó (`send-assessment-reminders`, 19/08) y a quien logueó pero dejó el assessment a medias (`send-incomplete-assessment-reminder`, NUEVO 22/08) |
| **Dashboard interno de estado** | ✅ `assessment-dashboard.html` + `get-dashboard-stats`, con login (14/08/2026) — reemplaza una versión que se rompió con el fix de seguridad del 12/08 |
| **Producto "solo Nivel 1" (`NIVEL1_ONLY`)** | ✅ Wireado y verificado de punta a punta; bug de scoring de Listening/Reading corregido el 12/08/2026; bug de ruta (podía escapar a OET/STEPS2 si el estudiante sacaba B2 en todo) corregido el 14/08/2026 — ver 6.8 |

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

### 18/08/2026

1. **URLs de booking de Calendar actualizadas** en `speaking.html`: se reemplazaron los links de reserva de Google Calendar para las rutas OET y CEFR/English (`BOOKING_URLS.OET` y `BOOKING_URLS.CEFR`) por los links vigentes. Cambio solo de configuración (hardcodeado en el archivo), sin lógica nueva ni impacto en el resto del flujo.

### 21/08/2026

1. **Unificación de este documento**: existían dos archivos de brief en el repo, `BRIEF.md` y `BRIEF_1.md`, ambos con el mismo header "Actualizado: 14 de agosto de 2026" pero contenido distinto en la sección 6.8 — `BRIEF_1.md` (subido una sola vez ese día vía "Add files via upload", sin ninguna referencia desde el código ni desde otro documento) ya reflejaba el fix del bug de ruteo de `NIVEL1_ONLY` como corregido, mientras que `BRIEF.md` seguía diciendo que estaba abierto. El commit real (`a7f2d24`, 14/08/2026, "Implement track handling for NIVEL1_ONLY in routing") confirma que el fix se aplicó ese mismo día. Se fusionó todo en este archivo, que queda como la única versión, y se eliminó `BRIEF_1.md`.
2. **`generate-report` — tanda grande de cambios pedidos por Diana tras revisar reportes reales (v7 a v11):**
   - **v7**: Speaking ahora se espera e incluye en LOS DOS TRACKS (antes `NIVEL1_ONLY` mandaba el reporte sin esperar Speaking, aunque el estudiante sí lo rinde — se detectó con dos casos reales, Laura Noguera y "Flaco"). El bloque de Speaking tipo English deja de usar el estilo rojo de alerta. El checklist de pronunciación (17 ítems) se resume en 3 grupos neutros ("Logrado", "En desarrollo", "A reforzar") en vez de listar solo los ítems débiles en rojo.
   - **v8**: se saca "...guardados en la plataforma" del subtítulo (lenguaje de backend). El nivel CEFR general deja de ser un solo nivel y pasa a ser el **rango** entre las 2 destrezas más bajas de Nivel 1.
   - **v9**: el encabezado ahora muestra primero "Resultados por destreza" (las 4 de Nivel 1 + Speaking) y después el resumen global. Cuando la ruta es OET o STEPS2 se agregan filas con la escala nativa de cada prueba (ver rúbrica, sección 3.5) en vez de forzarlas a CEFR.
   - **v10**: fix de paginación en la tarjeta de Writing — el mismo bug que v6 ya había arreglado en `.skill-row` (`page-break-inside: avoid` empujando el bloque entero a la página siguiente y dejando un hueco enorme) seguía presente en `.writing-essay`. Se sacó ahí también.
   - **v11**: se agrega al final del reporte, antes del footer, un bloque invitando a reservar la Q&A Session de 30 min (ya incluida, no opcional).
3. **`submit-writing` v17**: todo el feedback que escribe la IA (comentario general, las 6 dimensiones, justificación CEFR) se pide explícitamente en español (tuteo) — antes el prompt completo estaba en inglés y la IA respondía en inglés. Las citas textuales del propio texto del estudiante nunca se traducen.
4. **`submit-writing` v18**: se agrega `correcciones_para_b2` al JSON de la IA — lista de hasta 5 errores concretos con corrección y explicación, pensada para el reporte (no se le muestra al estudiante en vivo). Ver rúbrica completa en 3.5.

### 22/08/2026

1. **`submit-writing` v19**: el tope de `correcciones_para_b2` sube de 5 a 7 ítems — Diana identificó más errores aprovechables en textos reales de prueba de los que el tope anterior dejaba mostrar.
2. **`generate-report` v13**: en la tarjeta de Writing de Nivel 1, debajo del feedback general, se agrega la lista de "Correcciones para llegar a B2" citando fragmentos concretos del propio texto del estudiante.
3. **Fix de login (`index.html` / `index-nivel1.html`)**: si el estudiante ya completó su assessment (`attempt.status === 'completed'`) y vuelve a entrar con su código, ya no se lo manda de nuevo por `welcome.html`/`intake.html` — se lo lleva directo a `siguiente.html` (el router), que lo manda a su siguiente paso real (normalmente `speaking.html` a agendar, si todavía no lo agendó).
4. **`send-incomplete-assessment-reminder` (NUEVO)**: recordatorio por correo, un solo envío por `attempt_id`, a estudiantes que loguearon pero dejaron el assessment a medias y cuya sesión ya venció (a raíz del caso de Yinessa Toledo). v2 el mismo día: se excluyen estudiantes que ya tienen otro `attempt` `completed` — bug real encontrado en producción (login crea un attempt nuevo vacío si alguien reingresa después de terminar; sin este filtro, a Fer RPS y a Paula Elena Hernández Quiroz les habría llegado un "no terminaste" habiendo terminado). Cron horario, no diario como `send-assessment-reminders`. No está en el repo — ver 6.9.

### 23-24/08/2026

> Los timestamps de despliegue en Supabase caen la noche del 23/08 (hora de Bogotá); los comentarios que Diana pidió agregar en el propio código dicen "24/08/2026" — probablemente por una diferencia de huso horario del reloj usado al escribirlos. Se listan acá como un solo bloque de trabajo.

1. **Rescate de OET para Listening (`LISTENING_B2_RESCUE_THRESHOLD = 75`, caso de Juan Sebastián)**: nueva lógica en `js/scoring.js` (commit `dd734b3`, "Implement listening OET rescue threshold logic"), `submit-response` (v20) y `submit-writing` (v3 de `recomputeRouteAndPersist`) — ver el detalle completo en 3.4 y 3.5. Pedido explícito de Diana, solo para Listening.
2. **Fix real en `submit-writing` (caso de Paula, rubric_version `cefr-anchored-v10-borderline-note`)**: la regla "la duda favorece al estudiante" (26/07/2026) dependía de que la IA la aplicara sola dentro del prompt. En el caso de Paula, la IA marcó `borderline_decision: true` pero igual devolvió el nivel bajo (B1), dejándola afuera de OET sin motivo. Se corrigió forzando el nivel alto en el código (v9) y agregando una nota visible en el reporte cuando esto pasa (v10) — ver 3.5.
3. **`generate-partial-report` (NUEVO)**: función hermana de `generate-report` — arma y manda un PDF parcial (sin Speaking) apenas termina la parte escrita del assessment (`attempts.status = 'completed'`), en vez de esperar el resultado de Speaking. Idempotente vía `attempts.partial_report_sent_at`. Incluye una integración opcional con Google Drive (domain-wide delegation vía cuenta de servicio) que queda inactiva hasta que Diana cargue los secrets correspondientes — ver 3.3 y 6.10. Probada en producción: los 3 `attempts` que completaron la parte escrita hasta ahora ya recibieron su reporte parcial.
4. **No está en el repo todavía**: ni el rescate de Listening del lado servidor, ni el fix del caso de Paula, ni `generate-partial-report` tienen commit en GitHub — viven desplegados en Supabase. `js/scoring.js` (el espejo client-side del rescate) sí se subió (commit `dd734b3`), pero el resto de estos cambios de Edge Functions no. Ver 6.9. **Actualización de la tarde:** al subir `submit-response/index.ts` completo por el punto 5 de abajo, el rescate de Listening del lado servidor y el `triggerPartialReport` de `submit-response` sí quedaron commiteados — solo falta `submit-writing` (fix del caso de Paula) y `generate-partial-report`.

### 24/08/2026 "tarde" — Rediseño del banco de STEP CK 2

1. **Rediseño completo del banco de STEP CK 2** (pedido de Diana, a partir de datos reales: las preguntas se estaban errando mucho). Se confirmó por SQL que las 8 preguntas originales (formato USMLE, caso clínico + "cuál es el mejor próximo paso") tenían 0%-50% de aciertos por pregunta — medían conocimiento médico/de manejo clínico, no la habilidad de lectura en inglés que este módulo dice evaluar. Se mantuvo el texto de cada una de las 8 viñetas clínicas sin tocar, pero se reemplazó la pregunta final de opción múltiple por DOS preguntas de comprensión lectora: una de **gist** (idea principal / por qué se menciona tal dato del caso) y una de **vocabulario en contexto** (una palabra o expresión C1-C2 tomada literalmente del texto). Esto llevó el banco de 8 a 16 preguntas, cada una con 4 opciones (antes 5).
2. Antes de cargarlas se hizo una auditoría explícita de **cognados con el español**: se detectaron y reemplazaron 6 palabras de vocabulario que un hispanohablante podía adivinar sin leer nada (*unresponsive*, *distended*, *lethargic*, *migratory*, *uncomplicated*, *delivery* como anglicismo cotidiano). También se corrigieron, en rondas sucesivas de revisión con Diana: distractores que no compartían el campo semántico de la palabra objetivo (ej. una pregunta sobre "blood-streaked" con opciones que ni mencionaban sangre, fácil de descartar por tema en vez de por significado); una opción correcta que repetía literalmente la palabra objetivo del enunciado; las 16 respuestas correctas cayendo todas en la posición A (reordenadas para repartirse entre A/B/C/D); y varias opciones correctas notablemente más largas/elaboradas que las demás (un "tip" clásico de examen), reescritas con largo y estructura pareja.
3. **`data/steps2.json`** se reescribió con las 16 preguntas (mismo id para las 8 de "gist", que reemplazan a las preguntas originales; 8 ids nuevos para las de "vocabulario"), `time_limit_seconds` subió de 900 a 1800 (30 min, dado el doble de preguntas) y `_meta.totalQuestions` a 16. **`question_bank`** en Supabase se actualizó igual (8 `update` + 8 `insert`, mismo criterio de ids) y se verificó fila por fila.
4. **`submit-response.ts` no necesitó ningún cambio de lógica** — el cálculo de STEP CK 2 ya es 100% dinámico (cuenta las preguntas del módulo en runtime, nunca un número fijo), así que 12/16 sigue siendo el mismo 75% que antes era 6/8. Se redesplegó igual como v32, solo para documentar el cambio en el comentario junto a `STEPS2_PASS_THRESHOLD`.
5. **Sincronización del repo con lo desplegado**: aprovechando este deploy, se subió a GitHub el contenido completo y actualizado de `supabase/functions/submit-response/index.ts` (antes desactualizado, le faltaban el rescate de Listening y `triggerPartialReport` — ver punto 4 de la entrada anterior). `js/app-steps2.js` también se actualizó (comentario de cabecera describiendo el rediseño). Contenido completo pregunta por pregunta entregado a Diana como archivo aparte para su revisión antes de aplicar el cambio.

### 31/08/2026 — Generalización del rescate de OET y regla "3 de 4 skills" (caso de Luis Padilla)

1. **Motivo**: Luis Padilla completó Nivel 1 con un perfil fuerte pero desparejo — Grammar y Reading en C1, Listening con el ceiling cortado en B1 pero con 75% de aciertos reales en la banda C1 (un "traspié" en una banda intermedia, el mismo patrón del caso de Juan Sebastián), y Writing en B1. Con la regla vieja ("las 4 en B2+", más el rescate de Listening acotado a la banda B2) no calificaba para OET. Diana pidió generalizar el mecanismo en vez de parchear el caso puntual.
2. **`highestPassingBand(perBand)`** (nueva función, `js/scoring.js` + replicada en `submit-response`/`submit-writing`): reemplaza `LISTENING_B2_RESCUE_THRESHOLD`. Recorre TODAS las bandas A1→C1 sin cortar en la primera que falla, y devuelve la más alta que llegó a ≥70% — se aplica a Grammar, Listening y Reading por igual (antes solo Listening, y solo mirando la banda B2 con un umbral de 75%). El resultado se guarda como `band_detail.oet_effective_level`; si queda por encima del ceiling, además se guarda `oet_unlock_override: true` y una nota (`oet_unlock_note`) — igual mecanismo que antes, generalizado. **El ceiling mostrado al estudiante y en el reporte no cambia.**
3. **Regla de desbloqueo de OET, de "4 de 4" a "3 de 4 con piso B1"** (`MIN_LEVEL_FLOOR_FOR_OET = "B1"`): `recomputeRouteAndPersist` ahora arma el nivel efectivo de las 4 destrezas (`oet_effective_level` si existe, si no el ceiling) y asigna OET si al menos 3 de las 4 llegan a B2+ Y las 4 llegan al menos a B1. El piso evita que una destreza genuinamente floja (A1/A2) quede compensada por las otras tres. Ver detalle completo en 3.4/3.5.
4. **Desplegado**: `submit-response` v33, `submit-writing` v35 (misma función de ruteo compartida), `generate-partial-report` v9 y `generate-report` v21 (ambos generalizan `oet_unlock_note`, antes filtrado a `sk === "listening"`). `js/scoring.js` actualizado y subido a GitHub por Diana (commit `763b00b8`, "Refactor scoring logic and update comments") — es el único de estos 4 cambios que sí llegó al repo, ver 6.9.
5. **Recalculado a mano el attempt ya completado de Luis Padilla** (`e16d24d5-...`) para que quede bajo la regla nueva: se le agregó `oet_effective_level`/`oet_unlock_note` a sus `sub_scores` de listening (C1, con nota), grammar y reading (B1/C1, sin override), se cambió su `unlock_state.assigned_route` a `OET`, se reseteó su reserva de Speaking (`speaking_assessment_bookings`) a tipo `OET`/`pending` (**tenía un resultado tipo English cargado, pero Diana confirmó explícitamente que necesita rendir Speaking de nuevo como OET** — no alcanza con reusar el resultado viejo), y se revirtió su `attempts.status` a `in_progress` (con `report_sent_at`/`completed_at` en null) para que el flujo normal de "seguir completando el attempt" lo lleve a `oet-listening.html` en el próximo login — `get-unlock-state` decide la pantalla siguiente solo mirando `sub_scores`/`unlock_state.assigned_route`, nunca `attempts.status`, así que este backfill no necesitó ningún cambio de código.

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

- Actualizado al 24/08/2026: de los 20 estudiantes cargados, 7 crearon un `attempt` y 5 lo completaron (ver 3.2) — ya hay casos reales detrás de varios de los fixes de la sección 5 (Fer RPS, Paula, Juan Sebastián, Laura Noguera, Yinessa Toledo, entre otros).
- `test-flow.mjs` (Playwright) solo cubre login → intake; no se actualizó para cubrir Listening/Reading, `NIVEL1_ONLY`, el rescate de OET de Listening, ni el flujo de Speaking/reporte.
- 6 advertencias de seguridad de severidad baja (`search_path` mutable en funciones internas como `get_student_info` y varios triggers `populate_name`) quedaron anotadas por Diana para revisar más adelante — no son una fuga de datos, son buena práctica de Postgres.

### 6.8 ✅ NUEVO (14/08/2026) — `NIVEL1_ONLY` podía escapar a la ruta OET/STEPS2 — corregido

`recomputeRouteAndPersist` (duplicada en `submit-response` y `submit-writing`) asignaba la ruta del Nivel 1 solo mirando los 4 niveles CEFR, sin mirar `track`. Un estudiante `NIVEL1_ONLY` con B2 en las 4 destrezas hubiera terminado en la ruta OET (o STEPS2), con contenido médico que no le corresponde a este producto. Corregido el mismo día: ambas funciones ahora leen `attempts.track` y, si es `NIVEL1_ONLY`, fuerzan `assignedRoute = 'ENGLISH'` (y `speakingAssessmentType = 'English'`) sin evaluar los niveles CEFR — exactamente lo que dice la sección 1 de este brief. Desplegado en Supabase (`submit-response` v23, `submit-writing` v25). Sin impacto real hasta ahora (nadie completó un attempt real de `NIVEL1_ONLY` con ese resultado) y sin poder correr un test end-to-end en esta sesión (ver nota de red en sección 8) — conviene que Diana confirme con el próximo estudiante `NIVEL1_ONLY` que complete Nivel 1 con nivel alto.

### 6.9 🟡 NUEVO (24/08/2026), agravado el 31/08/2026 — Edge Functions desplegadas sin respaldo o desactualizadas en el repo

Es el mismo problema de la sección 6.5 (estructura de carpetas) pero un escalón peor: `generate-partial-report`, `send-incomplete-assessment-reminder`, `send-assessment-reminders`, `get-dashboard-stats`, `debug-signed-audio-url` y `test-grade-b2` corren en producción hoy pero **no tienen ningún archivo en GitHub** — ni siquiera suelto, como las 3 de 6.5. Si algo le pasa al proyecto de Supabase, el código de estas 6 funciones no está respaldado en ningún otro lado. Se corrige subiendo cada una a `supabase/functions/<nombre>/index.ts` — se puede hacer desde la interfaz web de GitHub ("Add file → Create new file", pegando el contenido que ya se bajó de Supabase vía MCP).

**31/08/2026:** con el deploy de la regla "3 de 4 skills" (ver historial, sección 5), `submit-response` (v33) y `submit-writing` (v35) — que sí tenían su código sincronizado con el repo desde el 24/08 — volvieron a quedar desactualizados en GitHub; `generate-report` (v21) sigue como archivo suelto y ya varias versiones atrás de lo desplegado (ver 6.5); `generate-partial-report` (v9) sigue sin ningún archivo en el repo. De estos 4, el único que sí se actualizó en GitHub fue el espejo client-side `js/scoring.js` (Diana lo subió el mismo día, commit `763b00b8`). Pendiente: subir el contenido actualizado de las 4 Edge Functions al repo.

### 6.10 🟡 NUEVO (24/08/2026) — Reporte parcial: subida a Google Drive inactiva

`generate-partial-report` intenta subir cada PDF parcial a una carpeta de Google Drive compartida (vía una cuenta de servicio con domain-wide delegation), pero se auto-omite sin fallar el envío del correo mientras falten dos secrets en Supabase: `GOOGLE_SERVICE_ACCOUNT_JSON` (el JSON completo de la cuenta de servicio) y `GOOGLE_DRIVE_FOLDER_ID` (la carpeta de Drive, compartida como Editor con el `client_email` de esa cuenta, y con el Client ID autorizado en el panel de administración del Workspace para impersonar a Diana). En cuanto Diana cargue esos dos secrets, el upload se activa solo, sin necesidad de un redeploy. También conviene actualizar `js/scoring.test.mjs` para cubrir la regla generalizada de la sección 3.4/3.5 (`highestPassingBand` en Grammar/Listening/Reading y la regla "3 de 4 con piso B1") — los 7 casos actuales no la prueban.

---

## 7. Backlog priorizado (sugerido)

1. Subir a GitHub las 6 Edge Functions sin ningún respaldo en el repo (ver 6.9) — más urgente que el punto 2, porque estas ni siquiera están como archivo suelto.
2. Cargar los secrets de Google Drive (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID`) para activar la subida del reporte parcial (ver 6.10).
3. Corregir la estructura de carpetas de las 3 Edge Functions nuevas (ver 6.5) — dejado pendiente a pedido de Diana por ahora.
4. Confirmar en producción el login de `assessment-dashboard.html` (Edge Function nueva, no se pudo probar de punta a punta desde esta sesión — ver 5, 14/08/2026).
5. Revisar las 6 advertencias de seguridad de severidad baja (`search_path` mutable, ver 6.7).
6. Limpiar los módulos "archivo" de `question_bank` (ver 6.2).
7. Definir si un estudiante puede reintentar el assessment completo (hoy no existe mecanismo de reintento).
8. Actualizar `test-flow.mjs` y `js/scoring.test.mjs` para cubrir Listening/Reading, `NIVEL1_ONLY`, la regla generalizada de rescate/3-de-4 (sección 3.4/3.5) y el flujo de Speaking/reporte.
9. Subir a GitHub el código actualizado de `submit-response` (v33) y `submit-writing` (v35), que volvieron a desactualizarse el 31/08/2026 (ver 6.9).

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
- **Ojo al subir `BRIEF.md`/`README.md` a GitHub:** ya pasó dos veces (14/08 con `BRIEF_1.md`, 21/08 con `BRIEF_2.md`/`README_1.md`) que al subir la versión actualizada se usa "Add file → Upload files" con GitHub sugiriendo un nombre nuevo (`_1`, `_2`) en vez de reemplazar el archivo original — quedan dos versiones circulando y nada avisa. Al subir estos documentos, hay que usar el botón "Edit"/"Replace" sobre el archivo `BRIEF.md`/`README.md` ya existente, nunca "Add file", y confirmar que el nombre final siga siendo exactamente `BRIEF.md`/`README.md`.
- **Ojo a la brecha entre lo desplegado en Supabase y lo que hay en el repo:** varias Edge Functions (ver 6.9) llevan días o semanas corriendo en producción sin que nadie las suba a GitHub como archivo. Antes de dar por "actualizado" este brief o el README, conviene comparar `mcp__Supabase__list_edge_functions` contra `supabase/functions/` del repo, no solo mirar los commits recientes — el código más nuevo puede vivir solo en Supabase.
