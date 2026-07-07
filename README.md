# ClearPath Assessment 360

Assessment 360 online para Speak Easy: **English Level → STEPS 2 → OET Skills → Roleplay oral**, con desbloqueo adaptativo por nivel y audios de reproducción limitada (imitando el formato OET).

## Estado actual (en construcción)

Lo que ya funciona:
- **Nivel 1 — English Level (Grammar)**: las 44 preguntas reales del banco de Diana, digitalizadas en `data/nivel1-grammar.json`, con timer de 20 minutos, cálculo de nivel CEFR por "ceiling" (sube de A1 a C1 mientras cada banda supere el umbral) y pantalla de resultados.
- Lógica de desbloqueo (`js/scoring.js`): STEPS 2 obligatorio y secuencial para todos; OET (y con él, el Roleplay) se desbloquea solo si grammar + listening + writing del Nivel 1 superan el umbral de "B1 alto" — probado con 5 casos en `js/scoring.test.mjs`.
- Esquema de base de datos para Supabase (`supabase/migrations/0001_init_schema.sql`), pensado para que el frontend público nunca pueda leer las respuestas correctas ni las reglas de desbloqueo directamente — eso vive del lado del servidor (Edge Functions + Row Level Security).

Lo que falta (backlog):
- Nivel 1 — Listening y Writing (guiones, audios vía ElevenLabs, consigna + rúbrica de writing).
- Módulo STEPS 2 (lectura clínica + razonamiento diagnóstico).
- Módulo OET Skills (Listening con audio de una sola reproducción, Reading).
- Roleplay oral: sistema de agenda para la sesión en vivo.
- Conectar todo a Supabase real (Auth por código de acceso, Storage privado para audios con URLs firmadas, Edge Functions de scoring).
- Dominio propio (`assessment.speakeasy.lat`) vía GitHub Pages.

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
