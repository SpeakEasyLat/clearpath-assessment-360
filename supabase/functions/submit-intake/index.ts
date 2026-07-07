// Edge Function: submit-intake
//
// Guarda el formulario de intake (NO calificado) que el estudiante completa
// antes de arrancar el examen: nivel autopercibido, experiencia previa
// estudiando ingles, que tanto usa el idioma, horas por semana disponibles,
// y dias/franjas horarias preferidas. Esto es solo contexto para Diana
// (armar horarios, reportes) -- nunca entra en el calculo de sub_scores ni
// de unlock_state.
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
    return json({ error: "Metodo no permitido." }, 405);
  }

           let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body invalido." }, 400);
  }

           const sessionToken = typeof body.session_token === "string" ? body.session_token.trim() : "";
  if (!sessionToken) {
    return json({ error: "Falta session_token." }, 400);
  }
  // El token es un uuid en la base -- si no tiene ese formato, la query de
           // abajo tira un error de Postgres ("invalid input syntax for type uuid")
           // en vez de simplemente no encontrar nada. Lo cortamos aca como 401
           // generico (sesion invalida), igual que si no existiera.
           const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionToken)) {
    return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
  }

           const selfPerceivedLevel = nonEmptyString(body.self_perceived_level);
  const timeSinceRegularPractice = nonEmptyString(body.time_since_regular_practice);
  const usageFrequency = nonEmptyString(body.usage_frequency);
  const weeklyHoursAvailable = nonEmptyString(body.weekly_hours_available);
  const priorExperience = stringArray(body.prior_experience);
  const preferredDays = stringArray(body.preferred_days);
  const preferredTimeSlots = stringArray(body.preferred_time_slots);

           if (
             !selfPerceivedLevel ||
             !timeSinceRegularPractice ||
             !usageFrequency ||
             !weeklyHoursAvailable ||
             priorExperience === null ||
             preferredDays === null ||
             preferredTimeSlots === null
             ) {
             return json({ error: "Faltan campos requeridos del formulario." }, 400);
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
             console.error("submit-intake: error buscando session", sessionError);
             return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
           }
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
  }
  const attemptId = session.attempt_id;

           // 2. Guardar (upsert: si el estudiante vuelve atras y cambia una respuesta
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
      weekly_hours_available: weeklyHoursAvailable,
      preferred_days: preferredDays,
      preferred_time_slots: preferredTimeSlots,
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
