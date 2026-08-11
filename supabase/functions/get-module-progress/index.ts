// Edge Function: get-module-progress
//
// Devuelve, para el attempt del session_token dado, cuales preguntas de un modulo de
// opcion multiple ya tienen una respuesta guardada en student_responses -- y cual fue
// esa respuesta.
//
// Motivo (pedido de Diana, 10/08/2026): si el estudiante recarga la pagina o pierde la
// conexion a mitad de un modulo, o entra de nuevo con el mismo codigo antes de terminar
// el attempt, el frontend usa esto para saltar directo a la primera pregunta sin
// responder en vez de reiniciar el modulo desde la pregunta 1 -- las respuestas ya
// guardadas en Supabase no se pierden nunca (submit-response las persiste al toque),
// pero sin este endpoint la pantalla no tenia forma de saber cuales eran.
//
// El frontend manda un "module_key" logico (grammar/listening/reading/oet_listening/
// oet_reading/steps2), NO el valor real de question_bank.module -- porque Listening y
// Reading de Nivel 1 tienen dos bancos distintos segun el track del estudiante
// (nivel1_listening / nivel1_listening_general, ver app-nivel1-listening.js;
// nivel1_reading / nivel1_reading_general, ver app-nivel1-reading.js), mientras que
// Grammar usa el mismo banco para los dos tracks (nivel1_grammar, sin variante
// _general). Este mapa resuelve module_key + track -> valor real de
// question_bank.module. OJO: debe mantenerse sincronizado a mano con MODULE_TO_SKILL
// de submit-response/index.ts y con que archivo JSON carga cada pantalla del
// frontend -- si el dia de manana se agrega un track o modulo nuevo, hay que tocar los
// dos lugares.
//
// No expone si la respuesta fue correcta ni ningun puntaje -- mismo cuidado que el
// resto del Nivel 1 (ver comentario en app-nivel1.js). Solo selected_answer, para poder
// remarcar la opcion elegida si el estudiante vuelve a esa pregunta con "Anterior".
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

// module_key (lo que manda el frontend) -> valor(es) real(es) de question_bank.module.
// Los que tienen variante _general resuelven segun el track del attempt (NIVEL1_ONLY
// usa la variante _general; FULL_360 o cualquier otro valor usa la normal).
const MODULE_KEY_TO_QUESTION_BANK_MODULE = {
grammar: { default: "nivel1_grammar" }, // mismo banco para los dos tracks
listening: { default: "nivel1_listening", NIVEL1_ONLY: "nivel1_listening_general" },
reading: { default: "nivel1_reading", NIVEL1_ONLY: "nivel1_reading_general" },
oet_listening: { default: "oet_listening" },
oet_reading: { default: "oet_reading" },
steps2: { default: "steps2" },
};

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
const moduleKey = typeof body.module === "string" ? body.module.trim() : "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!sessionToken || !UUID_RE.test(sessionToken)) {
return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
}
const moduleMapping = MODULE_KEY_TO_QUESTION_BANK_MODULE[moduleKey];
if (!moduleMapping) {
return json({ error: "Módulo inválido." }, 400);
}

const supabase = createClient(
Deno.env.get("SUPABASE_URL"),
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

const { data: session, error: sessionError } = await supabase
.from("attempt_sessions")
.select("attempt_id, expires_at")
.eq("token", sessionToken)
.maybeSingle();

if (sessionError) {
console.error("get-module-progress: error buscando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!session || new Date(session.expires_at).getTime() < Date.now()) {
return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
}
const attemptId = session.attempt_id;

// Resolver el track del attempt para elegir la variante _general cuando aplique.
const { data: attempt, error: attemptError } = await supabase
.from("attempts")
.select("track")
.eq("id", attemptId)
.maybeSingle();

if (attemptError) {
console.error("get-module-progress: error buscando attempt", attemptError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const track = attempt ? attempt.track : "FULL_360";
const questionBankModule =
track === "NIVEL1_ONLY" && moduleMapping.NIVEL1_ONLY ? moduleMapping.NIVEL1_ONLY : moduleMapping.default;

// Preguntas del modulo pedido (para filtrar student_responses solo a esas).
const { data: moduleQuestions, error: questionsError } = await supabase
.from("question_bank")
.select("id")
.eq("module", questionBankModule);

if (questionsError) {
console.error("get-module-progress: error buscando question_bank", questionsError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const moduleQuestionIds = new Set((moduleQuestions || []).map((q) => q.id));
if (moduleQuestionIds.size === 0) {
return json({ ok: true, answers: {} });
}

const { data: responses, error: responsesError } = await supabase
.from("student_responses")
.select("question_id, selected_answer")
.eq("attempt_id", attemptId)
.in("question_id", Array.from(moduleQuestionIds));

if (responsesError) {
console.error("get-module-progress: error buscando student_responses", responsesError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// Mapa question_id -> selected_answer (null si respondio "no se la respuesta").
const answers = {};
for (const r of responses || []) {
answers[r.question_id] = r.selected_answer;
}

return json({ ok: true, answers });
});
