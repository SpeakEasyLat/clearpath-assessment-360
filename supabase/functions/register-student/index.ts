// Edge Function: register-student
//
// Recibe los datos del formulario de intake que completa RPS cada vez que se
// vende un Assessment 360 (nombre, correo, país, WhatsApp), genera un código
// de acceso único al azar, crea la fila en `students`, y devuelve el código
// para que el Google Apps Script del formulario se lo mande al estudiante.
//
// Seguridad: esta función NO usa verify_jwt (así el Apps Script no necesita
// manejar tokens de Supabase), pero exige un header `x-register-secret` que
// tiene que coincidir con el secreto guardado en REGISTER_STUDENT_SECRET
// (Supabase → Project Settings → Edge Functions → Secrets). Sin este chequeo,
// cualquiera que mire el código público del sitio podría crear estudiantes
// falsos, porque la SUPABASE_ANON_KEY que usa el frontend es pública a propósito.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-register-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Sin caracteres ambiguos (0/O, 1/I/L) para que el estudiante lo transcriba bien.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateAccessCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `CP-${code}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Método no permitido." }, 405);
  }

  const expectedSecret = Deno.env.get("REGISTER_STUDENT_SECRET");
  const providedSecret = req.headers.get("x-register-secret");
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({ error: "No autorizado." }, 401);
  }

  let body: { full_name?: unknown; email?: unknown; country?: unknown; whatsapp?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body inválido." }, 400);
  }

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const country = typeof body.country === "string" ? body.country.trim() : "";
  const whatsapp = typeof body.whatsapp === "string" ? body.whatsapp.trim() : "";

  if (!fullName || !email) {
    return json({ error: "Falta nombre y/o correo." }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Genera el código y reintenta si por casualidad ya existe (muy improbable
  // con 6 caracteres de un alfabeto de 32, pero mejor cubrirlo).
  let accessCode = "";
  let student = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    accessCode = generateAccessCode();
    const { data, error } = await supabase
      .from("students")
      .insert({ full_name: fullName, email, country, whatsapp, access_code: accessCode })
      .select("id, full_name, email, access_code")
      .single();

    if (!error) {
      student = data;
      break;
    }
    // 23505 = unique_violation (el código ya existía) -> reintenta con uno nuevo.
    if (error.code !== "23505") {
      console.error("register-student: error creando student", error);
      return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
    }
  }

  if (!student) {
    return json({ error: "No se pudo generar un código único. Intenta de nuevo." }, 500);
  }

  return json({
    ok: true,
    full_name: student.full_name,
    email: student.email,
    access_code: student.access_code,
  });
});
