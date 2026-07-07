-- Fix 1: reemplazar la vista SECURITY DEFINER (implicita) por el patron recomendado:
-- security_invoker + grant explicito por columna + policy RLS con USING (true).
-- Resultado funcional identico (anon puede leer las columnas no sensibles de todas las
-- preguntas a traves de la vista), pero de forma explicita y auditable en vez de depender
-- del bypass implicito de RLS que ocurre con SECURITY DEFINER.

alter view student_facing_questions set (security_invoker = true);

grant select (id, module, position, cefr_level, question_text, options, audio_asset_id)
  on question_bank to anon;

create policy "anon puede leer todas las filas via la vista publica"
  on question_bank
  for select
  to anon
  using (true);

-- Fix 2: la funcion rls_auto_enable() (creada por la opcion "Enable automatic RLS" al
-- crear el proyecto) no necesita ser invocable manualmente por el publico -- el event
-- trigger que la dispara automaticamente al crear tablas nuevas sigue funcionando igual,
-- esto solo le saca el acceso directo via la API REST/RPC.
revoke execute on function public.rls_auto_enable() from anon, authenticated;
