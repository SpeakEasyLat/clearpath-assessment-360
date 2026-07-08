// Edge Function: get-audio-url
//
// Devuelve una signed URL de corta duracion (2 minutos) para reproducir un audio
// de Listening, validando la sesion del estudiante (session_token, igual que en
// submit-response) y aplicando el limite de reproducciones por attempt
// (audio_assets.max_plays, comparado contra audio_play_log).
//
// El bucket "audio-assets" es privado y storage.objects no tiene NINGUNA politica
// RLS para "anon" ni "authenticated" -- la unica forma de que el navegador consiga
// una URL utilizable es a traves de esta funcion, que corre con el service_role
// key (inyectado automaticamente por Supabase, nunca expuesto al navegador).
//
// El navegador nunca ve audio_assets.storage_path ni audio_assets.max_plays
// directamente (esa tabla no tiene grants para "anon"); solo recibe la URL firmada
// y el conteo de reproducciones usadas/permitidas para poder deshabilitar el boton
// de "reproducir" en el frontend.

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

const SIGNED_URL_TTL_SECONDS = 120; // 2 minutos: alcanza para escuchar, no queda "viva" mucho tiempo.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const audioAssetId = typeof body.audio_asset_id === "string" ? body.audio_asset_id.trim() : "";

if (!sessionToken || !audioAssetId) {
return json({ error: "Faltan session_token o audio_asset_id." }, 400);
}
if (!UUID_RE.test(sessionToken) || !UUID_RE.test(audioAssetId)) {
return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
}

const supabase = createClient(
Deno.env.get("SUPABASE_URL"),
Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

// 1. Validar la sesion (misma logica que submit-response).
const { data: session, error: sessionError } = await supabase
.from("attempt_sessions")
.select("attempt_id, expires_at")
.eq("token", sessionToken)
.maybeSingle();

if (sessionError) {
console.error("get-audio-url: error buscando session", sessionError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!session || new Date(session.expires_at).getTime() < Date.now()) {
return json({ error: "Sesion invalida o expirada. Volve a ingresar tu codigo de acceso." }, 401);
}
const attemptId = session.attempt_id;

// 2. Buscar el audio (storage_path y max_plays nunca se exponen a "anon").
const { data: audioAsset, error: audioError } = await supabase
.from("audio_assets")
.select("id, storage_path, max_plays")
.eq("id", audioAssetId)
.maybeSingle();

if (audioError) {
console.error("get-audio-url: error buscando audio_asset", audioError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}
if (!audioAsset) {
return json({ error: "Audio no encontrado." }, 404);
}

// 3. Contar reproducciones ya usadas por este attempt para este audio.
const { count: playsUsed, error: countError } = await supabase
.from("audio_play_log")
.select("id", { count: "exact", head: true })
.eq("attempt_id", attemptId)
.eq("audio_asset_id", audioAsset.id);

if (countError) {
console.error("get-audio-url: error contando reproducciones", countError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

const used = playsUsed ?? 0;
if (used >= audioAsset.max_plays) {
return json(
{
error: "Ya alcanzaste el maximo de reproducciones para este audio.",
plays_used: used,
max_plays: audioAsset.max_plays,
},
403,
);
}

// 4. Generar la signed URL ANTES de registrar el play: si createSignedUrl
// falla, no se descuenta una reproduccion de mas.
const { data: signed, error: signError } = await supabase
.storage
.from("audio-assets")
.createSignedUrl(audioAsset.storage_path, SIGNED_URL_TTL_SECONDS);

if (signError || !signed) {
console.error("get-audio-url: error generando signed URL", signError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

// 5. Registrar la reproduccion.
const { error: logError } = await supabase
.from("audio_play_log")
.insert({ attempt_id: attemptId, audio_asset_id: audioAsset.id });

if (logError) {
console.error("get-audio-url: error registrando reproduccion", logError);
return json({ error: "Error interno. Intenta de nuevo en un momento." }, 500);
}

return json({
url: signed.signedUrl,
plays_used: used + 1,
max_plays: audioAsset.max_plays,
});
});
