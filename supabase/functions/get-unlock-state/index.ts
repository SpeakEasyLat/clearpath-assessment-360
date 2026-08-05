// Edge Function: get-unlock-state
//
// Devuelve el estado de desbloqueo actual del attempt para que la pantalla de Speaking
// muestre SOLO el boton que le corresponde al estudiante segun su resultado (OET o CEFR
// English), y para que el router (siguiente.html, tarea 1.5) sepa a que pantalla mandar
// al estudiante despues de cada modulo. No expone puntajes, aciertos ni respuestas --
// solo la ruta / el siguiente paso.
//
// v3 (05/08/2026, tarea 1.6): agrega next_step_url y next_step_skill. Mira que
// sub_scores existen para este attempt (grammar, listening, writing, reading, en ese
// orden) y devuelve la URL del primero que falte; si los 4 ya existen, next_step_url es
// speaking.html. Asi ninguna pantalla del Nivel 1 necesita tener la URL del siguiente
// modulo escrita a mano (tarea 1.7) -- todas preguntan aca.
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

// Orden fijo del Nivel 1. Si el dia de manana se reordena o se agrega un modulo, este
// es el UNICO lugar que hay que tocar -- ninguna pantalla del frontend tiene la URL del
// siguiente modulo escrita a mano.
const NIVEL1_SEQUENCE = [
{ skill: "grammar", url: "nivel1.html" },
{ skill: "listening", url: "nivel1-listening.html" },
{ skill: "writing", url: "nivel1-writing.html" },
{ skill: "reading", url: "nivel1-reading.html" },
];

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!sessionToken || !UUID_RE.test(sessionToken)) {
return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
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
console.error("get-unlock-state: error buscando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!session || new Date(session.expires_at).getTime() < Date.now()) {
return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
}
const attemptId = session.attempt_id;

const { data: unlock, error: unlockError } = await supabase
.from("unlock_state")
.select("oet_unlocked, steps2_unlocked, speaking_assessment_type, assigned_route")
.eq("attempt_id", attemptId)
.maybeSingle();

if (unlockError) {
console.error("get-unlock-state: error buscando unlock_state", unlockError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const { data: subScores, error: subScoresError } = await supabase
.from("sub_scores")
.select("skill")
.eq("attempt_id", attemptId);

if (subScoresError) {
console.error("get-unlock-state: error buscando sub_scores", subScoresError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const completedSkills = new Set((subScores || []).map((s) => s.skill));

let nextStepUrl = "speaking.html";
let nextStepSkill = null;
for (const step of NIVEL1_SEQUENCE) {
if (!completedSkills.has(step.skill)) {
nextStepUrl = step.url;
nextStepSkill = step.skill;
break;
}
}
const nivel1Complete = nextStepSkill === null;

return json({
ok: true,
oet_unlocked: unlock ? unlock.oet_unlocked === true : false,
steps2_unlocked: unlock ? unlock.steps2_unlocked === true : false,
speaking_assessment_type: unlock ? unlock.speaking_assessment_type : null,
assigned_route: unlock ? unlock.assigned_route : null,
nivel1_complete: nivel1Complete,
next_step_skill: nextStepSkill,
next_step_url: nextStepUrl,
});
});
