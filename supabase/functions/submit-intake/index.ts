// Edge Function: submit-intake
//
// Guarda el formulario de intake (NO calificado) que el estudiante completa
// antes de arrancar el examen: nivel autopercibido, experiencia previa
// estudiando inglés y qué tanto usa el idioma. Esto es solo contexto para
// Diana -- nunca entra en el cálculo de sub_scores ni de unlock_state.
//
// NOTA (06/08/2026): a pedido de Diana se quitaron las preguntas de horas
// por semana disponibles, días preferidos y franjas horarias del formulario.
//
// v8 (10/08/2026, fix): el upsert seguía escribiendo weekly_hours_available,
// preferred_days y preferred_time_slots, pero Diana eliminó esas columnas de
// la tabla intake_responses porque ya no se incluyen en el assessment --
// Postgres rechazaba el upsert por columna inexistente y submit-intake
// devolvía 500 en TODAS las llamadas, rompiendo el paso de "Continuar al
// examen" para cualquier estudiante. Se quitan esos tres campos del upsert
// para que coincida con el esquema real de la tabla.
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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value) {
  if (!Array.isArray(value)) return null;
  const cleaned = value.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return cleaned;
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
  if (!sessionToken) {
    return json({ error: "Falta session_token." }, 400);
  }
  // El token es un uuid en la base -- si no tiene ese formato, la query de
  // abajo tira un error de Postgres ("invalid input syntax for type uuid")
  // en vez de simplemente no encontrar nada. Lo cortamos acá como 401
  // genérico (sesión inválida), igual que si no existiera.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionToken)) {
    return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
  }

  const selfPerceivedLevel = nonEmptyString(body.self_perceived_level);
  const timeSinceRegularPractice = nonEmptyString(body.time_since_regular_practice);
  const usageFrequency = nonEmptyString(body.usage_frequency);
  const priorExperience = stringArray(body.prior_experience);

  if (
    !selfPerceivedLevel ||
    !timeSinceRegularPractice ||
    !usageFrequency ||
    priorExperience === null
  ) {
    return json({ error: "Faltan campos requeridos del formulario." }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  );

  // 1. Validar la sesión (emitida por login) y que no haya expirado.
  const { data: session, error: sessionError } = await supabase
    .from("attempt_sessions")
    .select("attempt_id, expires_at")
    .eq("token", sessionToken)
    .maybeSingle();

  if (sessionError) {
    console.error("submit-intake: error buscando sesión", sessionError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
  }
  const attemptId = session.attempt_id;

  // 2. Guardar (upsert: si el estudiante vuelve atrás y cambia una respuesta
  // antes de arrancar el examen, se actualiza en vez de duplicar).
  const { error: upsertError } = await supabase
    .from("intake_responses")
    .upsert(
      {
        attempt_id: attemptId,
        self_perceived_level: selfPerceivedLevel,
        prior_experience: priorExperience,
        time_since_regular_practice: timeSinceRegularPractice,
        usage_frequency: usageFrequency,
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "attempt_id" },
    );

  if (upsertError) {
    console.error("submit-intake: error guardando intake", upsertError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  return json({ ok: true });
});
