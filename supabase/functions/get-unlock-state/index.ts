// Edge Function: get-unlock-state
//
// Devuelve el estado de desbloqueo actual del attempt (oet_unlocked y
// speaking_assessment_type) para que la pantalla de Speaking muestre SOLO el botón que
// le corresponde al estudiante según su resultado (OET o CEFR English). No expone
// puntajes, aciertos ni respuestas -- solo la ruta de speaking que le tocó.
//
// Corre con el service_role key (inyectado automáticamente por Supabase).

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

const { data: unlock, error: unlockError } = await supabase
.from("unlock_state")
.select("oet_unlocked, steps2_unlocked, speaking_assessment_type")
.eq("attempt_id", session.attempt_id)
.maybeSingle();

if (unlockError) {
console.error("get-unlock-state: error buscando unlock_state", unlockError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

return json({
ok: true,
oet_unlocked: unlock ? unlock.oet_unlocked === true : false,
steps2_unlocked: unlock ? unlock.steps2_unlocked === true : false,
speaking_assessment_type: unlock ? unlock.speaking_assessment_type : null,
});
});
