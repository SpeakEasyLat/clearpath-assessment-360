# Brief — ClearPath Assessment 360

**Actualizado:** 8 de julio de 2026 (revisado más tarde el mismo día: se arregló Grammar y se sincronizó el repo — ver secciones 6.1, 6.2 y 6.3)
**Preparado por:** Claude, a partir de la revisión completa del repositorio (`SpeakEasyLat/clearpath-assessment-360`), la base de datos y las Edge Functions de Supabase (proyecto `qqdxmmvhthwcqhgmvyic`), y del historial de esta conversación.

> **Nota sobre el alcance de este brief:** no tengo forma de leer conversaciones de otras sesiones de chat fuera de esta. Este documento se armó revisando el estado *real* de las cosas — el código del repositorio, el historial completo de commits de git, el esquema y los datos actuales de Supabase, y las Edge Functions desplegadas — en vez de basarme solo en lo que se haya dicho en el chat. Donde encontré diferencias entre lo que el código dice que pasa y lo que realmente está pasando, las señalo explícitamente en la sección 6.

---

## 1. Qué es el proyecto

Assessment 360 es una plataforma de evaluación de inglés para Speak Easy, pensada específicamente para médicos que preparan el examen OET dentro del pathway ABR de radiología. El recorrido completo, tal como está diseñado, es:

**English Level → STEPS 2 → OET Skills → Speaking Assessment (sesión en vivo)**

con desbloqueo adaptativo según el desempeño del estudiante en cada nivel, y audios de reproducción limitada imitando el formato real del examen OET.

- **Repositorio (público):** `github.com/SpeakEasyLat/clearpath-assessment-360`
- **Sitio en vivo:** `assessment.speakeasy.lat` (GitHub Pages; usar `http://`, no `https://` — ver sección 6.4)
- **Backend:** Supabase, proyecto `qqdxmmvhthwcqhgmvyic`, región `sa-east-1`

---

## 2. Reglas no negociables del proyecto

Estas reglas se establecieron explícitamente contigo y rigen **todo** el desarrollo, sin excepción:

1. **Seguridad de contenido protegido.** Los audios y las respuestas correctas nunca deben subirse al repositorio público de GitHub. Todo el contenido protegido (audios, `correct_answer`, rúbricas de writing) vive en Supabase, detrás de Row Level Security y Edge Functions. La `service_role key` nunca se expone en el frontend/navegador.
2. **Idioma.** Todo el texto de cara al estudiante y también el texto para desarrolladores (comentarios de código, commits, este brief) va en español latinoamericano, con "tú" (nunca voseo), y con tildes y "ñ" correctos.
3. **Sin feedback en vivo.** El estudiante nunca ve si acertó o no una pregunta, ni ningún puntaje parcial mientras rinde el examen. Solo se le confirma que su respuesta se guardó, o que terminó el módulo. Tú revisas los resultados completos después.

---

## 3. Arquitectura técnica

### 3.1 Estructura del repositorio

```
index.html → login (código de acceso)
intake.html → formulario previo (no calificado)
nivel1.html → Nivel 1, Grammar
nivel1-listening.html → Nivel 1, Listening
css/style.css
js/app-intake.js
js/app-nivel1.js → lógica de Grammar (cliente; guarda cada respuesta vía submit-response, igual que Listening)
js/app-nivel1-listening.js → lógica de Listening (cliente)
js/scoring.js → algoritmo CEFR + reglas de desbloqueo (puro, con tests)
js/scoring.test.mjs
data/nivel1-grammar.json → 44 preguntas de Grammar (sin correct_answer)
data/nivel1-listening.json → 8 audios / 34 preguntas de Listening (sin correct_answer)
supabase/functions/ → código fuente de las Edge Functions (sincronizado con lo desplegado)
supabase/migrations/ → 8 migraciones SQL
CNAME → assessment.speakeasy.lat
```

### 3.2 Base de datos (Supabase, esquema actual en producción)

| Tabla | Filas hoy | Para qué sirve |
|---|---|---|
| `students` | 1 | Estudiantes, con `access_code` que generas a mano tras confirmar el pago |
| `attempts` | 1 | Una corrida completa del Assessment 360 |
| `question_bank` | 78 | Banco de preguntas (44 grammar + 34 listening; STEPS2/OET aún sin cargar). Incluye `answer_format` (`multiple_choice` / `note_completion`) y `accepted_answers` (variantes válidas) |
| `student_responses` | 34 | Respuestas guardadas server-side, con `is_correct` calculado por Edge Function |
| `sub_scores` | 1 | Ceiling CEFR por habilidad (grammar/listening/writing/steps2_reading) |
| `unlock_state` | 1 | Si se desbloqueó OET, STEPS2, y qué tipo de Speaking Assessment corresponde |
| `audio_assets` | 8 | Metadata de los audios de Listening (`storage_path`, `max_plays`) |
| `audio_play_log` | 1 | Registro de reproducciones ya usadas, para hacer cumplir `max_plays` |
| `writing_submissions` | 0 | Reservada para el módulo de Writing (no construido aún) |
| `speaking_assessment_bookings` | 0 | Reservada para agendar la sesión en vivo (OET o English) |
| `attempt_sessions` | 7 | Tokens de sesión (expiran 4 h después del login) |
| `intake_responses` | 1 | Respuestas del formulario previo (no calificado) |

Row Level Security está habilitado en todas las tablas. El rol `anon` (frontend público) solo puede leer la vista `student_facing_questions`, que expone las preguntas **sin** `correct_answer`. Todo lo demás pasa por Edge Functions con `service_role`.

Storage: bucket privado `audio-assets` con los 8 audios de Listening; cero políticas de acceso directo para `anon`/`authenticated` — las URLs firmadas (120 s de validez) las emite la Edge Function `get-audio-url`.

### 3.3 Edge Functions desplegadas

| Función | Versión desplegada | Qué hace |
|---|---|---|
| `login` | v1 | Valida `access_code`, crea/recupera `attempt`, emite `session_token` (expira en 4 h) |
| `submit-intake` | v2 | Guarda el formulario previo (no calificado) |
| `submit-response` | **v3** | Corrige la respuesta server-side, la guarda, y si con eso se completa el módulo, calcula el ceiling CEFR y recalcula `unlock_state` |
| `get-audio-url` | v1 | Valida sesión + `max_plays`, emite URL firmada (120 s), registra la reproducción |

✅ Las cuatro coinciden con el código fuente del repositorio (ver sección 6.2 y 6.3 — resuelto).

### 3.4 Algoritmo de scoring y reglas de desbloqueo (`js/scoring.js`)

- **Ceiling CEFR por banda:** para cada módulo tipo "escalera" (grammar, y a futuro STEPS2 reading), se sube de A1 en adelante mientras cada banda CEFR supere el 70% de acierto (`PERCENT_THRESHOLD`). En cuanto una banda no llega al umbral, ahí se corta el ceiling — no se "premian" aciertos sueltos en bandas más difíciles si hay un hueco antes.
- **Regla de desbloqueo de OET** (definida por ti): si grammar **y** listening **y** writing del Nivel 1 superan el umbral de "B1 alto" (modelado como ceiling ≥ B2 **y** ≥ 70% de acierto en la banda B1), se desbloquea el Speaking Assessment tipo OET (roleplay completo).
- **Si no se alcanza OET:** se mira el ceiling de reading + vocabulario médico de STEPS 2 (ignorando writing, speaking y grammar general):
- si ese ceiling ≥ B2 → el estudiante sigue en STEPS 2, sin sesión en vivo por ahora;
- si no llega a B2 → el estudiante queda en English Level y se desbloquea un Speaking Assessment breve tipo English.
- Esta lógica está **duplicada intencionalmente** en dos lugares: `js/scoring.js` (para el preview client-side de Grammar) y dentro de la Edge Function `submit-response` (que es la que de verdad decide `unlock_state` en la base de datos). Los umbrales (70%, B2) están hardcodeados en ambos lugares — si alguna vez los cambias, hay que tocar los dos.
- Cubierto por 7 casos de test en `js/scoring.test.mjs` (`node js/scoring.test.mjs` para correrlos).

⚠️ **Decisión pendiente de confirmar contigo, señalada en el propio código:** "B1 alto" no es un sub-nivel oficial del CEFR (el estándar es A1/A2/B1/B2/C1/C2). Se modeló como ceiling ≥ B2. Además, esta sesión dividí el "B2-C1" de tu guion de Listening en dos valores CEFR distintos (B2 para audios 5-6, C1 para audios 7-8), porque afecta directamente este cálculo de ceiling. Falta que confirmes si esa interpretación es la que querías.

---

## 4. Estado actual por módulo

| Módulo | Estado |
|---|---|
| **Login / sesión** | ✅ Completo y funcionando en producción |
| **Intake (formulario previo)** | ✅ Completo. Recoge nivel autopercibido, experiencia previa, frecuencia de uso, horas disponibles, días y horarios preferidos — para que armes horarios y reportes, no afecta ningún puntaje |
| **Nivel 1 — Grammar** | ✅ Arreglado (ver 6.1): las 44 preguntas se guardan vía `submit-response`, igual que Listening, con timer de 20 min. Falta que un estudiante real lo rinda completo en producción para confirmar el flujo de punta a punta con las 44 preguntas |
| **Nivel 1 — Listening** | ✅ Completo y verificado en vivo hoy (ver sección 5): 8 audios, 34 preguntas, incluye el formato "note completion" tipo OET para los audios 7 y 8, reproducción limitada a 2 veces con URL firmada, calificación server-side (incluye variantes de respuesta aceptadas e insensibilidad a mayúsculas), sin feedback en vivo |
| **Nivel 1 — Writing** | ❌ No construido (backlog) |
| **STEPS 2** (lectura clínica + vocabulario médico + razonamiento diagnóstico) | ❌ No construido (backlog) |
| **OET Skills** (Listening una sola reproducción, Reading) | ❌ No construido (backlog) |
| **Speaking Assessment (en vivo)** | ❌ No construido — la tabla `speaking_assessment_bookings` existe pero no hay UI ni flujo de agenda todavía |

### 5. Verificación en vivo de hoy (Listening)

Hoy completé una prueba end-to-end del módulo de Listening en producción, con la cuenta de prueba `DEMO-0001`:

- Las 34 preguntas de los 8 audios se guardaron correctamente en `student_responses`.
- La calificación server-side es correcta en todos los casos probados, incluyendo: respuestas correctas e incorrectas en multiple choice, una pregunta sin contestar (se guarda como `null` sin romper nada), y en note completion — insensibilidad a mayúsculas/minúsculas y coincidencia contra las variantes de `accepted_answers`.
- El límite de reproducciones (máx. 2 por audio) se hace cumplir server-side vía URL firmada de 120 segundos; el navegador nunca ve la ruta real del archivo.
- La navegación "Guardar y continuar" avanza correctamente entre los 8 audios (A2 → B1 → B2 → C1), el botón cambia a "Finalizar" en el último audio, y la pantalla final ("Listening completado") no muestra ningún acierto ni puntaje, tal como pediste.
- El renderizado de "note completion" (con el espacio en blanco en medio de la oración, no solo al final) funciona correctamente en los dos formatos usados (audio 7 y audio 8).

---

## 6. Problemas encontrados hoy (verificados contra el código real, no supuestos)

### 6.1 ✅ Grammar: la calificación no se estaba guardando (bug crítico) — RESUELTO

`js/app-nivel1.js` calificaba las respuestas **enteramente en el navegador**, comparando `selected === q.correct`. El problema era que `data/nivel1-grammar.json` **no tenía** el campo `correct` (se había quitado a propósito, por la regla de seguridad de la sección 2 — commit `73add5f`, "remove correct answers from public grammar JSON"). Como resultado, `q.correct` siempre era `undefined`, toda respuesta se marcaba como incorrecta, Grammar nunca llamaba a `submit-response`, y ningún estudiante podía desbloquear OET nunca (el sub-score de `grammar` jamás se calculaba del lado del servidor).

**Qué se hizo para arreglarlo (misma sesión):**

- `data/nivel1-grammar.json` ahora incluye el `id` real de cada pregunta en `question_bank` de Supabase (mismo patrón que `data/nivel1-listening.json`), además de `cefr_level` por pregunta.
- `js/app-nivel1.js` se reescribió para seguir exactamente el patrón de Listening: cada respuesta se guarda vía `submit-response` (con el `id` real de Supabase), y la pantalla ya **no** muestra nivel CEFR ni porcentaje de acierto en vivo — antes lo hacía, lo cual violaba la regla de "sin feedback en vivo" de la sección 2. Ahora, igual que Listening, solo confirma que se guardó cada respuesta y que el módulo quedó completo.
- Si se acaba el tiempo (20 min) con preguntas sin contestar, igual se guardan como "sin respuesta" (incorrectas) para que las 44 preguntas queden registradas y el módulo se pueda marcar completo del lado del servidor — si faltan filas en `student_responses`, `submit-response` nunca considera terminado el módulo y el desbloqueo de OET queda trabado, que era justamente la falla original.
- Se actualizó también la nota de desarrollo desactualizada en `index.html`, que todavía decía que Grammar calificaba del lado del cliente.
- **Verificado end-to-end** contra el backend real (login + submit-response con la cuenta `DEMO-0001` y una pregunta real de `question_bank`): la respuesta se guardó correctamente en `student_responses` con `is_correct` calculado server-side, sin que el navegador viera la respuesta correcta ni el resultado. El registro de prueba se borró después de verificar.

Pendiente: que un estudiante rinda las 44 preguntas completas en producción para confirmar que `sub_scores.grammar` y `unlock_state` se recalculan correctamente al completar el módulo (la lógica de agregación es la misma que ya funciona con Listening, pero no se probó con las 44 preguntas de Grammar de punta a punta).

### 6.2 ✅ La Edge Function `get-audio-url` no estaba en el repositorio de GitHub — RESUELTO

Se había creado y desplegado directamente a Supabase (vía MCP), pero nunca se guardó como archivo fuente en el repo. Ya se bajó el código fuente real desplegado y se commiteó en `supabase/functions/get-audio-url/index.ts`, verificado carácter por carácter contra lo que corre en producción.

### 6.3 ✅ El código de `submit-response` en el repositorio no coincidía con lo desplegado — RESUELTO

La función desplegada estaba en **v3** (con calificación de `note_completion`, variantes de `accepted_answers`, e insensibilidad a mayúsculas/espacios), mientras el repositorio tenía la **v2** (comparación exacta únicamente). Ya se actualizó `supabase/functions/submit-response/index.ts` en el repositorio con el código real de la v3, verificado carácter por carácter contra lo que corre en producción. El repo es ahora la fuente de verdad real para las cuatro Edge Functions desplegadas.

### 6.4 🟡 Detalles menores, ya conocidos

- `README.md` está desactualizado: todavía dice que Listening y Writing no están construidos, y no menciona el flujo de Intake ni las tablas agregadas después de la migración inicial.
- `https://assessment.speakeasy.lat` da error de privacidad; hay que usar `http://` por ahora — pendiente de que GitHub Pages complete la elegibilidad para "Enforce HTTPS" (se resuelve solo, no requiere acción).
- Migración más reciente en producción: `20260708015035_listening_answer_format_and_fk` (agregó `answer_format` y `accepted_answers` a `question_bank`) — coincide con el repo.

---

## 7. Backlog priorizado (sugerido)

1. ~~Arreglar Grammar~~ — ✅ hecho (sección 6.1).
2. ~~Sincronizar el repo con lo desplegado~~ — ✅ hecho (secciones 6.2 y 6.3).
3. **Confirmar la decisión de CEFR B2/C1** para los audios 5-8 de Listening (ver sección 3.4).
4. Construir **Nivel 1 — Writing** (consigna + rúbrica + evaluación, probablemente con IA).
5. Construir **STEPS 2** (lectura clínica + vocabulario médico + razonamiento diagnóstico).
6. Construir **OET Skills** (Listening de una sola reproducción, Reading).
7. Construir el flujo de **Speaking Assessment** (agenda de la sesión en vivo, tanto OET como English) — la tabla ya existe, falta la UI/flujo.
8. Actualizar `README.md` para que refleje el estado real.
9. Housekeeping: borrar la cuenta de prueba `DEMO-0001` de Supabase cuando termines de revisar los datos de la prueba de hoy; borrar el archivo local `nivel1-listening-audio1-cafeteria.mp3` (42 KB, roto) de tu OneDrive.

---

## 8. Notas técnicas para la próxima sesión

- El patrón correcto para cualquier módulo nuevo de examen es el que usa Listening: el frontend nunca calcula si algo es correcto, siempre llama a `submit-response` con `session_token` + `question_id` + `selected_answer`, y la Edge Function hace todo el trabajo (calificar, guardar, y si el módulo se completa, recalcular `sub_scores` y `unlock_state`).
- Para editar archivos en el editor web de GitHub (CodeMirror 6) de forma confiable: usar `document.querySelector('.cm-content').cmTile.view` para acceder al `EditorView` real, y `view.state.doc.toString()` para leer el contenido completo y verdadero del documento (el `.innerText` del `.cm-content` **no** sirve para verificar — solo refleja la porción virtualizada visible, no el documento completo).
- Todas las claves usadas en el frontend (`SUPABASE_ANON_KEY`) son la clave **anon/publishable**, no la `service_role` — está bien que estén hardcodeadas en el JS público, es el diseño intencional.
