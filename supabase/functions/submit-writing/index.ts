// Edge Function: submit-writing
//
// Recibe el texto de una tarea de writing (session_token + prompt_id + response_text),
// lo guarda, y -- a pedido explícito de Diana -- lo califica con IA del lado del
// servidor combinando DOS marcos: (A) una escala de placement 0-10 (Beginner ->
// Excellent, basada en desarrollo del tema, claridad de propósito, organización,
// control del lenguaje, precisión y rango) y (B) el nivel CEFR. NUNCA le devuelve al
// estudiante puntaje ni nivel en vivo: solo "guardado / módulo terminado".
//
// El módulo Nivel 1 - Writing tiene 2 tareas (una general más fácil y una médica tipo
// OET más difícil). El sub_score de writing y el desbloqueo de OET se calculan recién
// cuando AMBAS tareas están enviadas y calificadas, promediando el CEFR de las dos.
//
// La API key de IA vive SOLO en un secret de Supabase (ANTHROPIC_API_KEY), nunca en el
// navegador. Corre con el service_role key (inyectado automáticamente por Supabase).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
"Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
return new Response(JSON.stringify(body), {
status,
headers: { "Content-Type": "application/json", ...CORS_HEADERS },
});
}

// --- Mismos umbrales y algoritmo de desbloqueo que submit-response / js/scoring.js ---
const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1"];
const MIN_LEVEL_FOR_OET = "B2";
const MIN_LEVEL_FOR_STEPS2 = "B2";
const PLACEMENT_MAX = 10; // escala 0-10 por tarea

function meetsLevel(level, minLevel) {
if (!level) return false;
const idx = CEFR_ORDER.indexOf(level);
const minIdx = CEFR_ORDER.indexOf(minLevel);
return idx >= 0 && minIdx >= 0 && idx >= minIdx;
}

// Promedia niveles CEFR de varias tareas -> un nivel CEFR del módulo.
// Redondeo al más cercano, con empate hacia abajo (conservador, coherente con la
// filosofía de "ceiling" del resto del proyecto).
function averageCefr(levels) {
const idxs = levels
.map((l) => CEFR_ORDER.indexOf(l))
.filter((i) => i >= 0);
if (idxs.length === 0) return null;
const mean = idxs.reduce((a, b) => a + b, 0) / idxs.length;
// empate (x.5) hacia abajo: usar Math.ceil(mean - 0.5)
const rounded = Math.max(0, Math.min(CEFR_ORDER.length - 1, Math.ceil(mean - 0.5)));
return CEFR_ORDER[rounded];
}

function buildGradingPrompt(promptRow, responseText) {
return `You are an expert examiner placing an adult English learner's writing on a level. Grade the response below using TWO combined frameworks.

FRAMEWORK A - a 0 to 10 placement scale (integer). Judge the writing holistically across these six qualities:
1. Topic development - how fully and with how little apparent effort the task/topic is developed.
2. Clarity of purpose - how clear the writer's aim and the purpose of the text are.
3. Organization - how well organized the text is at both sentence and paragraph level.
4. Language control - how much control the writer has to express ideas, from very simple to more complex.
5. Accuracy - how frequent errors are in language use and standard writing conventions.
6. Range - how appropriate and wide the vocabulary and structures are.
Banding guide: 0-1 = very weak (topic barely developed, purpose unclear, little language control, very many errors, little appropriate vocabulary); 2-3 = low; 4-5 = fair; 6-7 = good; 8-9 = very good; 10 = excellent (topic fully developed and effortless, purpose perfectly clear, very well organized at sentence and paragraph level, wide range of appropriate vocabulary and structures, almost no errors).

FRAMEWORK B - the CEFR writing scale. Give a single holistic CEFR level, exactly one of: A1, A2, B1, B2, C1, using standard CEFR writing descriptors.

The CEFR estimate must be consistent with the placement band and the six qualities.

The writing task the student was given (title: "${promptRow.title}"):
"""
${promptRow.prompt_text}
"""

Respond with ONLY a valid JSON object, no markdown, no commentary, in exactly this shape:
{
  "placement_band": <integer 0-10>,
  "dimensions": {
    "topic_development": "<one short sentence>",
    "clarity_of_purpose": "<one short sentence>",
    "organization": "<one short sentence>",
    "language_control": "<one short sentence>",
    "accuracy": "<one short sentence>",
    "range": "<one short sentence>"
  },
  "overall_comment": "<two or three sentences summarizing the level>",
  "cefr_estimate": "<A1|A2|B1|B2|C1>"
}

Student's response:
"""
${responseText}
"""`;
}

// Llama a la API de Anthropic (Claude) y devuelve la calificación parseada.
// Provider por defecto: Anthropic. Para cambiar de proveedor, reemplazar esta función.
async function gradeWithAI(promptRow, responseText) {
const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
if (!apiKey) {
throw new Error("Falta el secret ANTHROPIC_API_KEY en Supabase.");
}
const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5-20250929";

const res = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"content-type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01",
},
body: JSON.stringify({
model,
max_tokens: 1024,
temperature: 0,
messages: [{ role: "user", content: buildGradingPrompt(promptRow, responseText) }],
}),
});

if (!res.ok) {
const errText = await res.text();
throw new Error(`API de IA respondió ${res.status}: ${errText.slice(0, 500)}`);
}

const data = await res.json();
const rawText = Array.isArray(data.content)
? data.content.map((c) => (typeof c.text === "string" ? c.text : "")).join("")
: "";

const start = rawText.indexOf("{");
const end = rawText.lastIndexOf("}");
if (start < 0 || end < 0 || end <= start) {
throw new Error("La IA no devolvió JSON parseable.");
}
const parsed = JSON.parse(rawText.slice(start, end + 1));

const cefr = typeof parsed.cefr_estimate === "string" ? parsed.cefr_estimate.trim().toUpperCase() : "";
if (!CEFR_ORDER.includes(cefr)) {
throw new Error(`cefr_estimate inválido devuelto por la IA: ${parsed.cefr_estimate}`);
}

let band = Number(parsed.placement_band);
if (!Number.isFinite(band)) band = 0;
band = Math.max(0, Math.min(PLACEMENT_MAX, Math.round(band)));

return {
cefr_estimate: cefr,
placement_band: band,
ai_rubric_scores: {
placement_band: band,
placement_max: PLACEMENT_MAX,
dimensions: parsed.dimensions || {},
overall_comment: typeof parsed.overall_comment === "string" ? parsed.overall_comment : "",
cefr_estimate: cefr,
model,
graded_at: new Date().toISOString(),
},
};
}

Deno.serve(async (req) => {
if (req.method === "OPTIONS") {
return new Response(null, { headers: CORS_HEADERS });
}
if (req.method !== "POST") {
return json({ error: "Método no permitido." }, 405);
}

let body;
try {
body = await req.json();
} catch {
return json({ error: "Body inválido." }, 400);
}

const sessionToken = typeof body.session_token === "string" ? body.session_token.trim() : "";
const promptId = typeof body.prompt_id === "string" ? body.prompt_id.trim() : "";
const responseText = typeof body.response_text === "string" ? body.response_text : "";

if (!sessionToken || !promptId) {
return json({ error: "Faltan session_token o prompt_id." }, 400);
}
if (!responseText.trim()) {
return json({ error: "El texto de tu respuesta está vacío." }, 400);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(sessionToken)) {
return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
}
if (!UUID_RE.test(promptId)) {
return json({ error: "Consigna no encontrada." }, 404);
}

const supabase = createClient(
Deno.env.get("SUPABASE_URL"),
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

// 1. Validar la sesión.
const { data: session, error: sessionError } = await supabase
.from("attempt_sessions")
.select("attempt_id, expires_at")
.eq("token", sessionToken)
.maybeSingle();

if (sessionError) {
console.error("submit-writing: error buscando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!session || new Date(session.expires_at).getTime() < Date.now()) {
return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
}
const attemptId = session.attempt_id;

// 2. Validar la consigna.
const { data: promptRow, error: promptError } = await supabase
.from("writing_prompts")
.select("id, module, title, prompt_text, cefr_target")
.eq("id", promptId)
.maybeSingle();

if (promptError) {
console.error("submit-writing: error buscando prompt", promptError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!promptRow) {
return json({ error: "Consigna no encontrada." }, 404);
}

// 3. Guardar (upsert) el texto -- aunque después la IA falle, el trabajo no se pierde.
const { error: upsertError } = await supabase
.from("writing_submissions")
.upsert(
{
attempt_id: attemptId,
prompt_id: promptRow.id,
response_text: responseText,
ai_rubric_scores: null,
cefr_estimate: null,
submitted_at: new Date().toISOString(),
},
{ onConflict: "attempt_id,prompt_id" },
);

if (upsertError) {
console.error("submit-writing: error guardando writing_submission", upsertError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 4. Calificar con IA. Si falla, el texto queda guardado y salimos sin bloquear.
let grading;
try {
grading = await gradeWithAI(promptRow, responseText);
} catch (err) {
console.error("submit-writing: fallo la calificación con IA", err);
return json({ ok: true, module_complete: false, graded: false });
}

// 5. Guardar la calificación de esta tarea.
const { error: gradeSaveError } = await supabase
.from("writing_submissions")
.update({
ai_rubric_scores: grading.ai_rubric_scores,
cefr_estimate: grading.cefr_estimate,
})
.eq("attempt_id", attemptId)
.eq("prompt_id", promptRow.id);

if (gradeSaveError) {
console.error("submit-writing: error guardando calificación", gradeSaveError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 6. ¿Están todas las tareas del módulo enviadas y calificadas?
const { data: modulePrompts, error: modulePromptsError } = await supabase
.from("writing_prompts")
.select("id")
.eq("module", promptRow.module);

if (modulePromptsError) {
console.error("submit-writing: error listando prompts del módulo", modulePromptsError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
const modulePromptIds = modulePrompts.map((p) => p.id);

const { data: submissions, error: submissionsError } = await supabase
.from("writing_submissions")
.select("prompt_id, cefr_estimate, ai_rubric_scores")
.eq("attempt_id", attemptId)
.in("prompt_id", modulePromptIds);

if (submissionsError) {
console.error("submit-writing: error listando submissions del módulo", submissionsError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const gradedSubs = submissions.filter((s) => typeof s.cefr_estimate === "string" && s.cefr_estimate);
const moduleComplete = gradedSubs.length >= modulePromptIds.length;

if (!moduleComplete) {
// Se guardó y calificó esta tarea, pero falta al menos otra para cerrar el módulo.
return json({ ok: true, module_complete: false, graded: true });
}

// 7. Módulo completo: promediar CEFR de las tareas y sumar bandas de placement.
const moduleCefr = averageCefr(gradedSubs.map((s) => s.cefr_estimate));
const rawScore = gradedSubs.reduce((sum, s) => {
const b = s.ai_rubric_scores && Number(s.ai_rubric_scores.placement_band);
return sum + (Number.isFinite(b) ? b : 0);
}, 0);
const maxScore = modulePromptIds.length * PLACEMENT_MAX;

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill: "writing",
raw_score: rawScore,
max_score: maxScore,
cefr_estimate: moduleCefr,
computed_at: new Date().toISOString(),
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error("submit-writing: error guardando sub_score", subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 8. Recalcular unlock_state (misma lógica exacta que submit-response).
const { data: allSubScores, error: allSubScoresError } = await supabase
.from("sub_scores")
.select("skill, cefr_estimate")
.eq("attempt_id", attemptId);

if (allSubScoresError) {
console.error("submit-writing: error leyendo sub_scores", allSubScoresError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const bySkill = Object.fromEntries(allSubScores.map((s) => [s.skill, s.cefr_estimate]));
const grammarOk = meetsLevel(bySkill.grammar, MIN_LEVEL_FOR_OET);
const listeningOk = meetsLevel(bySkill.listening, MIN_LEVEL_FOR_OET);
const writingOk = meetsLevel(bySkill.writing, MIN_LEVEL_FOR_OET);
const oetUnlocked = grammarOk && listeningOk && writingOk;

// Ruta binaria (decisión de Diana): si desbloquea OET -> Speaking OET;
// en cualquier otro caso (se queda en nivel CEFR) -> Speaking CEFR English.
// El estudiante no elige: la ruta depende solo del resultado.
const speakingAssessmentType = oetUnlocked ? "OET" : "English";

const { error: unlockError } = await supabase
.from("unlock_state")
.upsert(
{
attempt_id: attemptId,
steps2_unlocked: true,
oet_unlocked: oetUnlocked,
speaking_assessment_type: speakingAssessmentType,
updated_at: new Date().toISOString(),
},
{ onConflict: "attempt_id" },
);

if (unlockError) {
console.error("submit-writing: error actualizando unlock_state", unlockError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// Sin feedback de puntaje ni de nivel -- el estudiante solo sabe que terminó.
return json({ ok: true, module_complete: true, graded: true });
});
