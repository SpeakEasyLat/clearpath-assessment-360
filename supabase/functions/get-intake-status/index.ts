// Edge Function: get-intake-status
//
// Devuelve si el estudiante de este session_token ya llenó el formulario de intake
// (intake_responses, PK = attempt_id) para que app-intake.js no lo obligue a
// rellenarlo de nuevo si re-entra con el mismo código antes de terminar el attempt --
// mismo criterio que get-module-progress ya aplica a los módulos calificados (Grammar/
// Listening/Writing/Reading/OET/STEPS2), pedido de Diana el 26/08/2026 tras el caso de
// Araceli (se le trabó STEP CK 2 por el bug de app-steps2.js, y al volver a entrar la
// pantalla de intake la hacía repetir el formulario aunque ya lo había llenado).
//
// No expone el contenido del intake, solo si existe -- ese contenido es informativo
// para Diana (reportes/horarios), no calificado, y no hace falta en el frontend.
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
    console.error("get-intake-status: error buscando session", sessionError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
  }

  const { data: intake, error: intakeError } = await supabase
    .from("intake_responses")
    .select("attempt_id")
    .eq("attempt_id", session.attempt_id)
    .maybeSingle();

  if (intakeError) {
    console.error("get-intake-status: error buscando intake_responses", intakeError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  return json({ ok: true, completed: !!intake });
});
