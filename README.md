# ClearPath Assessment 360

Assessment 360 online para Speak Easy: **Welcome → Intake → English Level → (STEPS 2 *o* OET Skills, según el resultado) → Speaking Assessment (en vivo)**, con desbloqueo adaptativo por nivel y audios de reproducción limitada (imitando el formato OET).

## Estado actual

Lo que ya funciona:

- **Login** (`index.html` + Edge Function `login`): valida solo el código de acceso contra la tabla `students` precargada por Diana en Supabase. Nombre completo y correo se piden en la misma pantalla, pero son informativos/estéticos (solo se usan para personalizar el saludo en `welcome.html`, no se comparan contra lo precargado). Emite un `session_token` de 4 horas que el frontend usa en el resto de las llamadas en vez del código de acceso.
- **Welcome page** (`welcome.html`): pantalla informativa entre el login y el intake, con el objetivo del assessment, cómo está organizado, duración estimada, reglas del examen, recomendaciones antes de empezar y un pedido explícito de honestidad académica (sin traductores, sin IA, sin ayuda de terceros).
- **Intake** (`intake.html`): formulario previo no calificado (nivel autopercibido, experiencia previa, frecuencia de uso del idioma) para dar contexto sobre el estudiante.
- **Nivel 1 — English Level** (~1 hora en total): las 4 destrezas completas.
  - Grammar: 20 preguntas (`data/nivel1-grammar.json`), timer de 10 minutos, cálculo de nivel CEFR por "ceiling".
  - Listening: 5 audios (uno por banda A1-C1), 20 preguntas de opción múltiple, una sola reproducción por audio con URL firmada (sin timer explícito, pensado para ~10-11 minutos).
  - Reading: timer de 20 minutos.
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
- **Speaking Assessment** (`speaking.html`): pantalla de agenda que muestra el link correcto de Google Calendar (roleplay OET o conversación CEFR English) según el resultado del estudiante, sin que el estudiante elija.
- **Producto "solo Nivel 1" (`NIVEL1_ONLY`)** (agregado 07-08/08/2026): segmento de estudiantes que rinde únicamente Nivel 1 — English Level, sin pasar nunca por STEPS 2 ni OET, sin importar el resultado. Entran por `index-nivel1.html` (en vez de `index.html`), que manda `track: 'NIVEL1_ONLY'` a `login`; el `attempt` guarda ese track de forma permanente y `welcome-nivel1.html` muestra el branding correspondiente. Como esta pista es de público general (no médicos preparando OET), Listening y Reading usan **contenido separado y no médico**: `data/nivel1-listening-general.json` (5 audios: reservar mesa, pedido online, hotel, call center, IA en RRHH) y `data/nivel1-reading-general.json` (7 textos: horario de biblioteca, recordatorio de clase, sueño y aprendizaje, oficina open-plan, trabajo remoto, límites de datos autorreportados, offboarding en RRHH), servidos desde `js/app-nivel1-listening.js`/`js/app-nivel1-reading.js` según `sessionStorage.cp360_track`. En Supabase viven bajo módulos propios (`nivel1_listening_general` / `nivel1_reading_general`, separados de `nivel1_listening` / `nivel1_reading` que sigue usando la pista `FULL_360`) para que el conteo de módulo completo no se mezcle entre las dos pistas — mismo patrón que ya se usaba para separar `oet_listening`/`oet_reading` de Nivel 1. `submit-response` mapea ambos módulos nuevos a los skills `listening`/`reading` para que el ceiling CEFR funcione igual que en la pista completa. Probado de punta a punta el 08/08/2026 con una cuenta de prueba (login → Listening completo → Reading completo), sin errores.
- **Identidad visual**: logo real de Speak Easy · ClearPath integrado en todas las pantallas de la pista `FULL_360`; la pista `NIVEL1_ONLY` usa en cambio el logo genérico de Speak Easy (sin "ClearPath") en login, welcome, Listening y Reading.
- **Registro automático de estudiantes (RPS)**: el formulario "ASSESSMENT 360 - STUDENT INTAKE" (Google Forms) está conectado vía Google Apps Script a la Edge Function `register-student`, que crea el estudiante en Supabase con un código de acceso único (`CP-XXXXXX`) y le envía un correo automático con ese código (con copia para Speak Easy). Pensado para que RPS lo complete cada vez que se vende un Assessment 360, después de confirmar el pago.
- **Edge Functions desplegadas**: `login` (v8), `submit-intake` (v7), `submit-response` (v15), `submit-writing` (v18), `get-unlock-state` (v7), `get-audio-url` (v5), `register-student` (v3). También existe `debug-anthropic`, una función de diagnóstico interno para probar la conexión con la API de Anthropic (no forma parte del flujo del estudiante).
- **Esquema de base de datos para Supabase** (`supabase/migrations/0001_init_schema.sql`), pensado para que el frontend público nunca pueda leer las respuestas correctas ni las reglas de desbloqueo directamente.

Lo que falta (backlog):

- Persistir el progreso del estudiante dentro de un módulo (parte actual, tiempo restante y reproducciones de audio ya usadas). Hoy ese progreso vive solo en memoria del navegador: si el estudiante recarga la página o cierra la pestaña a mitad de un módulo, vuelve a la primera parte de ese módulo con un timer nuevo, y si esa primera parte ya usó su única reproducción de audio, no puede volver a escucharla.
- Reporte final para el estudiante (hay una skill de reporte OET instalada que puede servir de base).
- Panel de resultados para Diana (hoy los resultados se revisan por consulta SQL directa).
- Resolver el HTTPS/DNS del dominio propio (`assessment.speakeasy.lat`) vía GitHub Pages, para que no salga "conexión no segura".
- Definir si un estudiante puede reintentar el assessment completo (hoy no existe ningún mecanismo de reintento).

## ⚠️ Nota de seguridad importante

Los audios y las respuestas correctas **no deben subirse nunca a este repositorio**. Este repo es público y solo debe contener código (HTML/CSS/JS) y el banco de preguntas *sin* marcar cuál es la correcta si en algún momento se sirve directo al navegador. El contenido protegido (audios, respuestas correctas, rúbricas) vive en Supabase, detrás de Row Level Security y Edge Functions — ver el comentario al inicio de `supabase/migrations/0001_init_schema.sql`.

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
