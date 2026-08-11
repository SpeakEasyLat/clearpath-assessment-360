// Edge Function: register-speaking-booking
//
// Hasta ahora, la reserva del Speaking Assessment (OET o CEFR English) dependía
// solo del clic en el botón de Google Calendar en speaking.html: no quedaba
// ningún registro en Supabase de quién reservó ni cuándo -- speaking_assessment_bookings
// existía en el schema pero nunca se insertaba nada ahí. Pedido de Diana (backlog,
// 11/08/2026): persistir cada clic en "Agendar" en esa tabla, para tener visibilidad
// real de quién reservó, sin depender de que Google Calendar le avise a este sitio
// (cosa que no hace).
//
// Diseño idempotente: si el estudiante hace clic más de una vez (o recarga la página
// y vuelve a hacer clic), NO se crea una fila nueva -- se reutiliza la que ya existe
// para ese attempt_id. Esto es intencional: un estudiante solo tiene un Speaking
// Assessment por intento, sin importar cuántas veces haya hecho clic en el botón.
//
// No bloquea la redirección a Google Calendar ni a thankyou.html -- el frontend
// dispara esta llamada en paralelo (fire-and-forget) y no espera su respuesta para
// seguir. Si esta función falla, el estudiante igual llega a su reserva; solo se
// pierde el registro interno, no la experiencia del estudiante.
//
// Corre con el service_role key (inyectado automaticamente por Supabase).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Método no permitido." }, 405);
  }

  let body: { session_token?: unknown };
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
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: session, error: sessionError } = await supabase
    .from("attempt_sessions")
    .select("attempt_id, expires_at")
    .eq("token", sessionToken)
    .maybeSingle();

  if (sessionError) {
    console.error("register-speaking-booking: error buscando session", sessionError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return json({ error: "Sesión inválida o expirada. Vuelve a ingresar tu código de acceso." }, 401);
  }
  const attemptId = session.attempt_id;

  // Idempotencia: si ya existe una reserva para este attempt, no crear otra.
  const { data: existing, error: existingError } = await supabase
    .from("speaking_assessment_bookings")
    .select("id, assessment_type, status")
    .eq("attempt_id", attemptId)
    .maybeSingle();

  if (existingError) {
    console.error("register-speaking-booking: error buscando booking existente", existingError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }
  if (existing) {
    return json({ ok: true, booking_id: existing.id, already_existed: true });
  }

  const { data: unlock, error: unlockError } = await supabase
    .from("unlock_state")
    .select("speaking_assessment_type")
    .eq("attempt_id", attemptId)
    .maybeSingle();

  if (unlockError) {
    console.error("register-speaking-booking: error buscando unlock_state", unlockError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  const assessmentType = unlock ? unlock.speaking_assessment_type : null;
  if (!assessmentType) {
    // El estudiante todavía no debería estar viendo el botón de agendar si esto pasa
    // -- lo tratamos como un pedido inválido en vez de crear una reserva sin sentido.
    return json({ error: "Speaking Assessment todavía no está habilitado para este intento." }, 409);
  }

  const { data: attempt, error: attemptError } = await supabase
    .from("attempts")
    .select("student_id")
    .eq("id", attemptId)
    .maybeSingle();

  if (attemptError) {
    console.error("register-speaking-booking: error buscando attempt", attemptError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  let studentName: string | null = null;
  let studentEmail: string | null = null;
  if (attempt && attempt.student_id) {
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("full_name, email")
      .eq("id", attempt.student_id)
      .maybeSingle();
    if (studentError) {
      console.error("register-speaking-booking: error buscando student", studentError);
      // No es crítico para registrar la reserva -- seguimos sin nombre/correo antes
      // que fallar del todo.
    } else if (student) {
      studentName = student.full_name;
      studentEmail = student.email;
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("speaking_assessment_bookings")
    .insert({
      attempt_id: attemptId,
      assessment_type: assessmentType,
      student_name: studentName,
      student_email: studentEmail,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("register-speaking-booking: error insertando booking", insertError);
    return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
  }

  return json({ ok: true, booking_id: inserted.id, already_existed: false });
});
