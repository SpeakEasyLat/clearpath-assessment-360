// Edge Function: submit-response
//
// Recibe la respuesta que el estudiante elige para una pregunta (session_token +
// question_id + selected_answer), la corrige contra question_bank.correct_answer
// (que el navegador nunca ve), la guarda, y -- a pedido explicito de Diana -- NO
// devuelve si acerto o no, ni ningun puntaje parcial. El estudiante solo se entera
// de "guardado, pasa a la siguiente" (o "se termino este modulo"), nunca de su
// desempeno en vivo.
//
// Cuando la respuesta guardada completa todas las preguntas del modulo para este
// attempt, calcula el sub_score (ceiling CEFR, igual al algoritmo de js/scoring.js)
// y recalcula el desbloqueo de OET / STEPS 2 / Speaking Assessment.
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

const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1"];
const PERCENT_THRESHOLD = 70;
const MIN_LEVEL_FOR_OET = "B2";
const MIN_LEVEL_FOR_STEPS2 = "B2";

const MODULE_TO_SKILL = {
nivel1_grammar: "grammar",
nivel1_listening: "listening",
steps2: "steps2_reading",
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
//   abajo tira un error de Postgres ("invalid input syntax for type uuid")
//   en vez de simplemente no encontrar nada. Lo cortamos aca como 401
//   generico (sesion invalida), igual que si no existiera.
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
.select("id, module, cefr_level, correct_answer")
.eq("id", questionId)
.maybeSingle();

if (questionError) {
console.error("submit-response: error buscando question", questionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!question) {
return json({ error: "Pregunta no encontrada." }, 404);
}

const isCorrect = selectedAnswer !== null && selectedAnswer === question.correct_answer;

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

// 5. Modulo completo: calcular el ceiling CEFR (mismo algoritmo que js/scoring.js).
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
const totalCorrect = responses.filter((r) => r.is_correct === true).length;

const skill = MODULE_TO_SKILL[question.module];
if (skill) {
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
},
{ onConflict: "attempt_id,skill" },
);

if (subScoreError) {
console.error("submit-response: error guardando sub_score", subScoreError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 6. Recalcular desbloqueos con todos los sub_scores disponibles hasta ahora.
const { data: allSubScores, error: allSubScoresError } = await supabase
.from("sub_scores")
.select("skill, cefr_estimate")
.eq("attempt_id", attemptId);

if (allSubScoresError) {
console.error("submit-response: error leyendo sub_scores", allSubScoresError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const bySkill = Object.fromEntries(allSubScores.map((s) => [s.skill, s.cefr_estimate]));
const grammarOk = meetsLevel(bySkill.grammar, MIN_LEVEL_FOR_OET);
const listeningOk = meetsLevel(bySkill.listening, MIN_LEVEL_FOR_OET);
const writingOk = meetsLevel(bySkill.writing, MIN_LEVEL_FOR_OET);
const oetUnlocked = grammarOk && listeningOk && writingOk;

const steps2Level = bySkill.steps2_reading ?? null;
const steps2Ok = steps2Level == null ? null : meetsLevel(steps2Level, MIN_LEVEL_FOR_STEPS2);

let speakingAssessmentType = null;
if (oetUnlocked) {
speakingAssessmentType = "OET";
} else if (steps2Ok === false) {
speakingAssessmentType = "English";
}

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
console.error("submit-response: error actualizando unlock_state", unlockError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
}

// Sin feedback de puntaje ni de nivel -- el estudiante solo sabe que este modulo termino.
return json({ ok: true, module_complete: true });
});
