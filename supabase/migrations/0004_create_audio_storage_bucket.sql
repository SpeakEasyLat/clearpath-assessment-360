-- Bucket privado para los audios del Listening (Nivel 1, OET Listening, etc.).
-- public = false: NINGÚN rol público puede leer objetos por URL directa.
-- No se agregan policies de storage.objects para anon/authenticated: como RLS en
-- storage.objects es "default deny" (sin policy = sin acceso), y el rol service_role
-- siempre bypassea RLS (atributo bypassrls), el resultado es exactamente lo que
-- necesitamos: SOLO las Edge Functions (usando el service_role key) pueden leer/escribir
-- objetos acá, y solo entregan acceso al estudiante emitiendo URLs firmadas de corta
-- duración. El frontend público (rol anon) nunca tiene acceso directo al bucket.
insert into storage.buckets (id, name, public)
values ('audio-assets', 'audio-assets', false)
on conflict (id) do nothing;
