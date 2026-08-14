// Edge Function: submit-response
//
// Recibe la respuesta que el estudiante elige para una pregunta (session_token +
// question_id + selected_answer), la corrige contra question_bank.correct_answer /
// accepted_answers (que el navegador nunca ve), la guarda, y -- a pedido explicito
// de Diana -- NO devuelve si acerto o no, ni ningun puntaje parcial. El estudiante
// solo se entera de "guardado, pasa a la siguiente" (o "se termino este modulo"),
// nunca de su desempeno en vivo.
//
// Soporta dos formatos de pregunta (question_bank.answer_format):
//   - multiple_choice: selected_answer debe coincidir con correct_answer
//     (comparacion insensible a mayusculas/espacios).
//   - note_completion: selected_answer se compara contra CUALQUIERA de las
//     variantes en accepted_answers (ej. "4" y "four" son ambas correctas),
//     tambien insensible a mayusculas/espacios. Si accepted_answers viene
//     vacio o null, se usa correct_answer como unica variante valida.
//
// Cuando la respuesta guardada completa todas las preguntas del modulo para este
// attempt, calcula el sub_score (ceiling CEFR, igual al algoritmo de js/scoring.js)
// y recalcula la ruta del Nivel 1 (OET / STEPS2 / ENGLISH).
//
// v11 (06/08/2026): agrega OET Listening y OET Reading (Fase 4, module ===
// 'oet_listening' | 'oet_reading'). Decision de Diana: estos dos modulos son SOLO
// puntaje informativo -- los estudiantes que llegan aca ya calificaron para OET en el
// Nivel 1 (los 4 skills >= B2), asi que no hay banda CEFR ni aprobar/reprobar, solo
// raw_score/max_score para que Diana los revise. Rama nueva, analoga a steps2 pero sin
// threshold/passed. Tampoco llama a recomputeRouteAndPersist (la ruta del Nivel 1 ya
// quedo fija; estos sub_scores solo le sirven a get-unlock-state para encadenar las
// pantallas de OET).
//
// v10 (05/08/2026): agrega el modulo STEP CK 2 (module === 'steps2'). A diferencia de
// Grammar/Listening/Reading, sus preguntas tienen cefr_level = null (no hay bandas --
// decision de Diana: "en steps no hay banda, tiene que sacar al menos el 75% correcto
// para aprobarlos o falla"). Se agrega una rama separada que calcula porcentaje simple
// y pass/fail (>=75%) y la guarda en sub_scores.band_detail con cefr_estimate = null,
// sin pasar por computeCeiling()/detectPatternInconsistency() (que asumen bandas CEFR y
// siempre devolverian null/false para este modulo). No se llama a
// recomputeRouteAndPersist para steps2: la ruta del Nivel 1 (OET/STEPS2/ENGLISH) ya
// quedo fija cuando se completaron los 4 modulos de Nivel 1 y no depende de
// steps2_reading -- ese sub_score solo le sirve a get-unlock-state para saber si el
// estudiante ya rindio STEP CK 2.
//
// v9 (05/08/2026): decision de Diana -- "nunca decision manual, si es inconsistente
// debe quedar un registro en el resultado del assessment 360". Se agrega
// detectPatternInconsistency() y se persiste sub_scores.band_detail (jsonb, columna
// nueva via migracion sub_scores_band_detail) con el detalle por banda y un booleano
// pattern_inconsistent. Esto es SOLO diagnostico: el ceiling asignado y la ruta
// (OET/STEPS2/ENGLISH) se siguen calculando automaticamente, sin bloqueo, exactamente
// igual que antes -- nada queda esperando revision manual.
//
// v7 (05/08/2026, tarea 1.3): agrega "reading" a MODULE_TO_SKILL (modulo
// nivel1_reading) y reescribe la decision de ruta como las TRES ramas de
// claude/flujo-objetivo.md en vez de la regla binaria vieja (oetUnlocked ?
// 'OET' : 'English'). La decision de ruta (assignedRoute) solo se calcula y
// se guarda cuando existen los CUATRO sub_scores del Nivel 1 (grammar,
// listening, writing, reading) -- mientras falte alguno, queda en null
// ("pendiente"), igual que en js/scoring.js (deben mantenerse sincronizados,
// ver ese archivo para el razonamiento completo de la regla). Tambien marca
// attempts.status = 'completed' apenas se asigna la ruta (tarea 1.8).
//
// OJO: esta misma logica de recalculo de ruta (deciderAndPersistRoute) esta
// DUPLICADA en submit-writing, porque el sub_score de writing se calcula ahi
// (con IA) y no aca. Cualquier cambio a la regla debe aplicarse en los dos
// lugares. Mantenerlos sincronizados.
//
// Corre con el service_role key (inyectado automaticamente por Supabase).

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

// --- Mismos umbrales y algoritmo que js/scoring.js (mantenerlos sincronizados) ----
const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1"];
const PERCENT_THRESHOLD = 70;
const MIN_LEVEL_FOR_OET = "B2";
const MIN_LEVEL_FOR_STEPS2 = "B2";

// STEP CK 2 (Fase 3): pass/fail puro, sin bandas CEFR. Decision de Diana (05/08/2026):
// ">=75% correcto para aprobar". Con 8 preguntas eso es exactamente 6/8 (75.0%).
const STEPS2_PASS_THRESHOLD = 75;

// v13 (11/08/2026): agrega nivel1_listening_general y nivel1_reading_general (los
// modulos de Listening/Reading del track NIVEL1_ONLY / Assessment Speak Easy).
// BUG REAL encontrado antes de que ningun estudiante lo pisara (0 respuestas
// registradas en esos dos modulos al momento del fix): sin esta entrada, skill salia
// undefined para esos modulos, la rama `else if (skill)` de mas abajo nunca se
// ejecutaba, y el sub_score de listening/reading nunca se guardaba -- el estudiante
// terminaba el modulo en pantalla pero el attempt se quedaba sin ese sub_score para
// siempre, sin poder avanzar (nivel1Complete nunca se cumple). Fix aditivo, no toca
// ninguna rama existente.
//
// module (question_bank) -> skill (sub_scores).
const MODULE_TO_SKILL = {
nivel1_grammar: "grammar",
nivel1_listening: "listening",
nivel1_listening_general: "listening",
nivel1_reading: "reading",
nivel1_reading_general: "reading",
steps2: "steps2_reading",
oet_listening: "oet_listening",
oet_reading: "oet_reading",
};

function meetsLevel(level, minLevel) {
if (!level) return false;
const idx = CEFR_ORDER.indexOf(level);
const minIdx = CEFR_ORDER.indexOf(minLevel);
return idx >= 0 && minIdx >= 0 && idx >= minIdx;
}

function computeCeiling(perBand) {
let ceilingLevel = null;
for (const level of CEFR_ORDER) {
const band = perBand[level];
if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
ceilingLevel = level;
} else if (band && band.total > 0) {
break;
}
}
return ceilingLevel;
}

// Decision de Diana (05/08/2026): "nunca decision manual, si es inconsistente debe
// quedar un registro en el resultado del assessment 360". El ceiling YA se asigna
// siempre en forma automatica (nunca bloquea), pero un patron con "huecos" -- ej.
// aprueba B2 pero falla B1, o falla A1 pero aprueba A2+ -- merece quedar trazado
// para que Diana pueda auditarlo despues sin que nadie tenga que intervenir para
// que el estudiante avance. True cuando alguna banda POR ENCIMA del ceiling
// calculado (la banda donde se corto la racha, o cualquiera despues) en realidad
// supero el umbral.
function detectPatternInconsistency(perBand, ceilingLevel) {
const ceilingIdx = ceilingLevel ? CEFR_ORDER.indexOf(ceilingLevel) : -1;
for (let i = ceilingIdx + 1; i < CEFR_ORDER.length; i++) {
const band = perBand[CEFR_ORDER[i]];
if (band && band.total > 0 && band.percent >= PERCENT_THRESHOLD) {
return true;
}
}
return false;
}

// Normaliza para comparar respuestas de forma insensible a mayusculas/espacios
// (ej. " Four " === "four", "38.5" === "38.5 "). No toca acentos porque las
// respuestas de Listening/Reading son en ingles.
function normalizeAnswer(value) {
return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function gradeAnswer(question, selectedAnswer) {
if (selectedAnswer === null || selectedAnswer === undefined) return false;
const normalizedSelected = normalizeAnswer(selectedAnswer);
if (!normalizedSelected) return false;

if (question.answer_format === "note_completion") {
const variants = Array.isArray(question.accepted_answers) && question.accepted_answers.length > 0
? question.accepted_answers
: [question.correct_answer];
return variants.some((variant) => normalizeAnswer(variant) === normalizedSelected);
}

// multiple_choice (default)
return normalizedSelected === normalizeAnswer(question.correct_answer);
}

// Recalcula la ruta del Nivel 1 (OET / STEPS2 / ENGLISH) con TODOS los sub_scores
// disponibles hasta ahora, y la persiste en unlock_state + attempts.status. Devuelve
// el resultado por si el llamador lo necesita (no se usa hoy, pero deja la funcion
// reutilizable). Debe mantenerse identica a la version en submit-writing.
async function recomputeRouteAndPersist(supabase, attemptId) {
// v14 (14/08/2026, bug real encontrado antes de que ningun estudiante lo pisara):
// falta esta lectura de track, un estudiante de NIVEL1_ONLY que sacara B2 en las 4
// destrezas de Nivel 1 quedaba asignado a la ruta OET o STEPS2 igual que uno de
// FULL_360, y get-unlock-state lo mandaba a oet-listening.html/steps2.html --
// modulos con contenido medico que no existen para este producto. NIVEL1_ONLY debe
// quedar SIEMPRE en la ruta ENGLISH (Speaking breve tipo English), sin importar el
// resultado -- ver seccion 1 del Brief. Mantener sincronizado con submit-writing.
const { data: attemptRow, error: attemptTrackError } = await supabase
.from("attempts")
.select("track")
.eq("id", attemptId)
.maybeSingle();

if (attemptTrackError) {
console.error("submit-response: error leyendo track del attempt", attemptTrackError);
return { error: "Error interno. Intenta de nuevo en un momento." };
}
const track = attemptRow ? attemptRow.track : null;

const { data: allSubScores, error: allSubScoresError } = await supabase
.from("sub_scores")
.select("skill, cefr_estimate")
.eq("attempt_id", attemptId);

if (allSubScoresError) {
console.error("submit-response: error leyendo sub_scores", allSubScoresError);
return { error: "Error interno. Intenta de nuevo en un momento." };
}

// OJO: un sub_score puede existir con cefr_estimate = null (el estudiante no superó
// ni la banda A1 -- eso es un resultado legítimo, no "todavía no rindió"). Por eso
// "completo" se determina por la PRESENCIA de la fila en sub_scores (skillsPresent),
// nunca por si cefr_estimate es truthy. Confundir esto fue un bug real: un estudiante
// con reading por debajo de A1 se quedaba con assignedRoute = null para siempre.
const bySkill = Object.fromEntries(allSubScores.map((s) => [s.skill, s.cefr_estimate]));
const skillsPresent = new Set(allSubScores.map((s) => s.skill));
const grammarLevel = bySkill.grammar ?? null;
const listeningLevel = bySkill.listening ?? null;
const writingLevel = bySkill.writing ?? null;
const readingLevel = bySkill.reading ?? null;

const nivel1Complete =
skillsPresent.has("grammar") && skillsPresent.has("listening") && skillsPresent.has("writing") && skillsPresent.has("reading");

let assignedRoute = null;
let oetUnlocked = false;
let steps2Unlocked = false;
let speakingAssessmentType = null;

if (nivel1Complete) {
if (track === "NIVEL1_ONLY") {
// NIVEL1_ONLY nunca pasa por STEPS2 ni OET, sin importar el resultado (ver
// comentario mas arriba y seccion 1 del Brief) -- se fuerza ENGLISH sin
// evaluar los niveles CEFR.
assignedRoute = "ENGLISH";
oetUnlocked = false;
steps2Unlocked = false;
speakingAssessmentType = "English";
} else {
const allFourOk =
meetsLevel(grammarLevel, MIN_LEVEL_FOR_OET) &&
meetsLevel(listeningLevel, MIN_LEVEL_FOR_OET) &&
meetsLevel(writingLevel, MIN_LEVEL_FOR_OET) &&
meetsLevel(readingLevel, MIN_LEVEL_FOR_OET);
const readingOk = meetsLevel(readingLevel, MIN_LEVEL_FOR_STEPS2);

// Regla de Diana (claude/flujo-objetivo.md): los 4 >= B2 -> OET; si no, "el
// reading es la llave de STEPS 2" -- si reading >= B2 -> STEPS2; si no -> ENGLISH.
assignedRoute = allFourOk ? "OET" : (readingOk ? "STEPS2" : "ENGLISH");
oetUnlocked = assignedRoute === "OET";
steps2Unlocked = assignedRoute === "STEPS2";
// El modulo STEPS 2 (Fase 3) todavia no existe: mientras tanto, tanto la ruta
// STEPS2 como la ruta ENGLISH agendan el mismo Speaking Assessment breve tipo
// 'English' (ver diagrama en flujo-objetivo.md: STEPS 2 -> Link English Speaking).
speakingAssessmentType = assignedRoute === "OET" ? "OET" : "English";
}
}

const { error: unlockError } = await supabase
.from("unlock_state")
.upsert(
{
attempt_id: attemptId,
steps2_unlocked: steps2Unlocked,
oet_unlocked: oetUnlocked,
speaking_assessment_type: speakingAssessmentType,
assigned_route: assignedRoute,
updated_at: new Date().toISOString(),
},
{ onConflict: "attempt_id" },
);

if (unlockError) {
console.error("submit-response: error actualizando unlock_state", unlockError);
return { error: "Error interno. Intenta de nuevo en un momento." };
}

// v12 (10/08/2026, pedido de Diana): ya NO marcamos completed aca con solo
// nivel1Complete -- para las rutas OET y STEPS2 todavia quedan modulos pendientes en
// este punto (OET Listening/Reading/Writing, o STEP CK 2). Eso es lo que
// checkAndMarkAttemptComplete() (mas abajo) resuelve correctamente para las 3 rutas;
// se llama aca abajo con el assignedRoute recien calculado, y tambien se llama de
// forma independiente desde los otros puntos donde termina un modulo final de la ruta
// (steps2 en este mismo archivo, oet_writing en submit-writing) -- ver el comentario
// largo en esa funcion para el porque completo.
if (nivel1Complete) {
await checkAndMarkAttemptComplete(supabase, attemptId, assignedRoute);
}

return { assignedRoute, oetUnlocked, steps2Unlocked, speakingAssessmentType, nivel1Complete };
}

// Marca attempts.status = 'completed' solo cuando el estudiante ya no tiene NINGUN
// modulo pendiente segun la ruta que le toco -- no solo Nivel 1. Bug real que esto
// corrige (encontrado 10/08/2026): antes, el attempt se marcaba completed apenas
// terminaba Nivel 1 (los 4 sub_scores de grammar/listening/writing/reading), aunque
// para las rutas OET y STEPS2 todavia quedaran modulos por rendir (OET Listening/
// Reading/Writing, o STEP CK 2). Si en ese punto el estudiante recargaba la pagina o
// volvia a entrar con el mismo access_code, login() (attempt.status !== "in_progress"
// -> crear nuevo) le armaba un attempt en blanco y perdia TODO Nivel 1, no solo el
// modulo en el que estaba parado -- esto era el bug reportado como "me llevo a
// grammar". Ahora: ENGLISH no tiene modulos extra (Nivel 1 completo ya es todo el
// recorrido); OET necesita ademas oet_listening + oet_reading + oet_writing; STEPS2
// necesita ademas steps2_reading. Mientras falte alguno de esos, el attempt sigue
// in_progress y login() siempre retoma el mismo attempt sin importar cuantas veces el
// estudiante recargue o reingrese. Se llama desde el final de cada ruta: nivel1
// (recomputeRouteAndPersist, arriba, cubre ENGLISH), steps2 (mas abajo en este mismo
// archivo), y oet_writing (submit-writing/index.ts -- DUPLICADA alli, mantener
// sincronizada).
async function checkAndMarkAttemptComplete(supabase, attemptId, knownAssignedRoute) {
let assignedRoute = knownAssignedRoute;
if (assignedRoute === undefined) {
const { data: unlock, error: unlockError } = await supabase
.from("unlock_state")
.select("assigned_route")
.eq("attempt_id", attemptId)
.maybeSingle();
if (unlockError) {
console.error("checkAndMarkAttemptComplete: error leyendo unlock_state", unlockError);
return;
}
assignedRoute = unlock ? unlock.assigned_route : null;
}
if (!assignedRoute) return; // Nivel 1 todavia no termino -- nada que cerrar.

const { data: subScores, error: subScoresError } = await supabase
.from("sub_scores")
.select("skill")
.eq("attempt_id", attemptId);
if (subScoresError) {
console.error("checkAndMarkAttemptComplete: error leyendo sub_scores", subScoresError);
return;
}
const skillsPresent = new Set((subScores || []).map((s) => s.skill));

let fullJourneyComplete = false;
if (assignedRoute === "OET") {
fullJourneyComplete =
skillsPresent.has("oet_listening") && skillsPresent.has("oet_reading") && skillsPresent.has("oet_writing");
} else if (assignedRoute === "STEPS2") {
fullJourneyComplete = skillsPresent.has("steps2_reading");
} else {
fullJourneyComplete = true; // ENGLISH: Nivel 1 completo ya es todo el recorrido.
}
if (!fullJourneyComplete) return;

const { error: attemptError } = await supabase
.from("attempts")
.update({ status: "completed", completed_at: new Date().toISOString() })
.eq("id", attemptId)
.neq("status", "completed");
if (attemptError) {
console.error("checkAndMarkAttemptComplete: error marcando attempt completed", attemptError);
// No cortamos la respuesta por esto -- el router (get-unlock-state) sigue
// funcionando igual de bien con status in_progress. Se puede reintentar/corregir a
// mano si hace falta.
}
}

Deno.serve(async (req) => {
if (req.method === "OPTIONS") {
return new Response(null, { headers: CORS_HEADERS });
}
if (req.method !== "POST") {
return json({ error: "Metodo no permitido." }, 405);
}

let body;
try {
body = await req.json();
} catch {
return json({ error: "Body invalido." }, 400);
}

const sessionToken = typeof body.session_token === "string" ? body.session_token.trim() : "";
const questionId = typeof body.question_id === "string" ? body.question_id.trim() : "";
const selectedAnswer = typeof body.selected_answer === "string" ? body.selected_answer : null;

if (!sessionToken || !questionId) {
return json({ error: "Faltan session_token o question_id." }, 400);
}
// El token es un uuid en la base -- si no tiene ese formato, la query de
// abajo tira un error de Postgres ("invalid input syntax for type uuid")
// en vez de simplemente no encontrar nada. Lo cortamos aca como 401
// generico (sesion invalida), igual que si no existiera.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(sessionToken)) {
return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
}

const supabase = createClient(
Deno.env.get("SUPABASE_URL"),
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

// 1. Validar la sesion (emitida por login) y que no haya expirado.
const { data: session, error: sessionError } = await supabase
.from("attempt_sessions")
.select("attempt_id, expires_at")
.eq("token", sessionToken)
.maybeSingle();

if (sessionError) {
console.error("submit-response: error buscando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!session || new Date(session.expires_at).getTime() < Date.now()) {
return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
}
const attemptId = session.attempt_id;

// 2. Buscar la pregunta (con la respuesta correcta, invisible para el navegador).
const { data: question, error: questionError } = await supabase
.from("question_bank")
.select("id, module, cefr_level, correct_answer, answer_format, accepted_answers")
.eq("id", questionId)
.maybeSingle();

if (questionError) {
console.error("submit-response: error buscando question", questionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!question) {
return json({ error: "Pregunta no encontrada." }, 404);
}

const isCorrect = gradeAnswer(question, selectedAnswer);

// 3. Guardar la respuesta (upsert: si el estudiante vuelve atras y cambia la
// respuesta, se actualiza en vez de duplicar -- unique(attempt_id, question_id)).
const { error: upsertError } = await supabase
.from("student_responses")
.upsert(
{
attempt_id: attemptId,
question_id: question.id,
selected_answer: selectedAnswer,
is_correct: isCorrect,
},
{ onConflict: "attempt_id,question_id" },
);

if (upsertError) {
console.error("submit-response: error guardando respuesta", upsertError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 4. Ver si con esta respuesta se completo el modulo entero para este attempt.
const { count: totalInModule, error: totalError } = await supabase
.from("question_bank")
.select("id", { count: "exact", head: true })
.eq("module", question.module);

if (totalError) {
console.error("submit-response: error contando preguntas del modulo", totalError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const { data: moduleQuestions, error: moduleQuestionsError } = await supabase
.from("question_bank")
.select("id, cefr_level")
.eq("module", question.module);

if (moduleQuestionsError) {
console.error("submit-response: error listando preguntas del modulo", moduleQuestionsError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const moduleQuestionIds = moduleQuestions.map((q) => q.id);

const { data: responses, error: responsesError } = await supabase
.from("student_responses")
.select("question_id, is_correct")
.eq("attempt_id", attemptId)
.in("question_id", moduleQuestionIds);

if (responsesError) {
console.error("submit-response: error listando respuestas del modulo", responsesError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const moduleComplete = responses.length >= (totalInModule ?? moduleQuestionIds.length);

if (!moduleComplete) {
return json({ ok: true, module_complete: false });
}

// 5. Modulo completo: calcular el resultado. STEP CK 2 (module === 'steps2') es
// pass/fail simple sobre el total de preguntas -- sus filas en question_bank tienen
// cefr_level = null, asi que computeCeiling() siempre devolveria null para este
// modulo y no serviria. El resto de los modulos (grammar/listening/reading) siguen
// el ceiling CEFR de siempre (mismo algoritmo que js/scoring.js).
const totalCorrect = responses.filter((r) => r.is_correct === true).length;
const skill = MODULE_TO_SKILL[question.module];

if (skill && question.module === "steps2") {
const totalQuestions = moduleQuestionIds.length;
const percent = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
const passed = percent >= STEPS2_PASS_THRESHOLD;

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill,
raw_score: totalCorrect,
max_score: totalQuestions,
cefr_estimate: null,
computed_at: new Date().toISOString(),
band_detail: {
type: "pass_fail",
correct: totalCorrect,
total: totalQuestions,
percent,
threshold: STEPS2_PASS_THRESHOLD,
passed,
},
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error("submit-response: error guardando sub_score de steps2", subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
// No se llama a recomputeRouteAndPersist aca -- la ruta del Nivel 1 no depende de
// steps2_reading (ver comentario v10 arriba). get-unlock-state usa la presencia de
// este sub_score para saber que STEP CK 2 ya se rindio y mandar a speaking.html.
// STEP CK 2 es el ultimo modulo de la ruta STEPS2 -- si ya esta, el recorrido
// completo termino (v12, pedido de Diana 10/08/2026, ver checkAndMarkAttemptComplete
// mas arriba).
await checkAndMarkAttemptComplete(supabase, attemptId);
} else if (skill && (question.module === "oet_listening" || question.module === "oet_reading")) {
const totalQuestions = moduleQuestionIds.length;
const percent = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill,
raw_score: totalCorrect,
max_score: totalQuestions,
cefr_estimate: null,
computed_at: new Date().toISOString(),
band_detail: {
type: "informational",
correct: totalCorrect,
total: totalQuestions,
percent,
},
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error(`submit-response: error guardando sub_score de ${question.module}`, subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
// No se llama a recomputeRouteAndPersist aca -- la ruta del Nivel 1 ya quedo fija
// antes de llegar al modulo OET; este sub_score solo le sirve a get-unlock-state
// para saber que esta parte de OET ya se rindio y encadenar a la siguiente pantalla.
} else if (skill) {
const correctByQuestion = new Map(responses.map((r) => [r.question_id, r.is_correct === true]));
const perBand = {};
for (const level of CEFR_ORDER) {
const idsInBand = moduleQuestions.filter((q) => q.cefr_level === level).map((q) => q.id);
const correct = idsInBand.filter((id) => correctByQuestion.get(id)).length;
const total = idsInBand.length;
const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
perBand[level] = { correct, total, percent };
}
const ceilingLevel = computeCeiling(perBand);
const patternInconsistent = detectPatternInconsistency(perBand, ceilingLevel);

const { error: subScoreError } = await supabase
.from("sub_scores")
.upsert(
{
attempt_id: attemptId,
skill,
raw_score: totalCorrect,
max_score: moduleQuestionIds.length,
cefr_estimate: ceilingLevel,
computed_at: new Date().toISOString(),
// Solo diagnostico -- nunca cambia ceilingLevel ni bloquea la ruta. Ver
// detectPatternInconsistency() y la migracion sub_scores_band_detail.
band_detail: { perBand, pattern_inconsistent: patternInconsistent },
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error("submit-response: error guardando sub_score", subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 6. Recalcular la ruta del Nivel 1 con todos los sub_scores disponibles hasta ahora.
const routeResult = await recomputeRouteAndPersist(supabase, attemptId);
if (routeResult && routeResult.error) {
return json({ error: routeResult.error }, 500);
}
}

// Sin feedback de puntaje ni de nivel -- el estudiante solo sabe que este modulo termino.
return json({ ok: true, module_complete: true });
});
