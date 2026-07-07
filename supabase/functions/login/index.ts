// Edge Function: login
//
// Recibe el access_code que Diana le da al estudiante (generado a mano tras confirmar
// el pago) y, si es valido, crea o retoma su "attempt" y le devuelve un session_token
// de corta duracion (4 horas) que el frontend usa en todas las llamadas posteriores
// (enviar respuesta, pedir audio, etc.) en vez del access_code.
//
// Corre con el service_role key (inyectado automaticamente por Supabase en runtime),
// asi que puede leer/escribir todo. Nunca se expone ese key al navegador: el frontend
// solo manda el anon/publishable key en el header Authorization (requerido por
// verify_jwt) mas el access_code en el body.

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

const accessCode = typeof body.access_code === "string" ? body.access_code.trim() : "";
if (!accessCode) {
return json({ error: "Falta el codigo de acceso." }, 400);
}

const supabase = createClient(
Deno.env.get("SUPABASE_URL"),
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

// 1. Validar el codigo contra la tabla students.
const { data: student, error: studentError } = await supabase
.from("students")
.select("id, full_name")
.eq("access_code", accessCode)
.maybeSingle();

if (studentError) {
console.error("login: error buscando student", studentError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!student) {
return json({ error: "Codigo de acceso invalido." }, 401);
}

// 2. Retomar el attempt en progreso mas reciente, o crear uno nuevo.
const { data: existingAttempt, error: attemptLookupError } = await supabase
.from("attempts")
.select("id, status, started_at")
.eq("student_id", student.id)
.order("started_at", { ascending: false })
.limit(1)
.maybeSingle();

if (attemptLookupError) {
console.error("login: error buscando attempt", attemptLookupError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

let attempt = existingAttempt;
if (!attempt || attempt.status !== "in_progress") {
const { data: newAttempt, error: createAttemptError } = await supabase
.from("attempts")
.insert({ student_id: student.id })
.select("id, status, started_at")
.single();

if (createAttemptError) {
console.error("login: error creando attempt", createAttemptError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
attempt = newAttempt;
}

// 3. Asegurar que exista unlock_state para este attempt (defaults de la migracion 0001).
const { data: unlockState, error: unlockLookupError } = await supabase
.from("unlock_state")
.select("steps2_unlocked, oet_unlocked, speaking_assessment_type")
.eq("attempt_id", attempt.id)
.maybeSingle();

let unlock = unlockState;
if (!unlock) {
const { data: newUnlock, error: createUnlockError } = await supabase
.from("unlock_state")
.insert({ attempt_id: attempt.id })
.select("steps2_unlocked, oet_unlocked, speaking_assessment_type")
.single();

if (createUnlockError) {
console.error("login: error creando unlock_state", createUnlockError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
unlock = newUnlock;
}
if (unlockLookupError) {
console.error("login: error buscando unlock_state", unlockLookupError);
}

// 4. Emitir un session_token nuevo para esta sesion de navegador.
const { data: session, error: sessionError } = await supabase
.from("attempt_sessions")
.insert({ attempt_id: attempt.id })
.select("token, expires_at")
.single();

if (sessionError) {
console.error("login: error creando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

return json({
session_token: session.token,
expires_at: session.expires_at,
attempt: { id: attempt.id, status: attempt.status, started_at: attempt.started_at },
student: { full_name: student.full_name },
unlock_state: unlock,
});
});
