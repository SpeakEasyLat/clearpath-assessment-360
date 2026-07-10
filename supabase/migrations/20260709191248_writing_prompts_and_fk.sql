-- Migración: writing_prompts_and_fk
-- Tabla de consignas de Writing (Nivel 1 y a futuro otros módulos).
-- El texto de la consigna que ve el estudiante también vive en data/nivel1-writing.json
-- (público, seguro: una consigna de writing no tiene "respuesta correcta"). Esta tabla
-- es la fuente de verdad server-side y permite validar prompt_id + guardar config interna
-- (cefr_target, límites) que el navegador no necesita ver.
create table if not exists public.writing_prompts (
  id uuid primary key default gen_random_uuid(),
  module text not null default 'nivel1_writing',
  position integer not null,
  cefr_target text,
  title text not null,
  prompt_text text not null,
  guidance text,
  min_words integer not null default 120,
  max_words integer not null default 220,
  time_limit_seconds integer not null default 1800,
  created_at timestamptz not null default now(),
  unique (module, position)
);

-- RLS habilitado sin políticas para anon/authenticated: solo la Edge Function
-- (service_role) puede leerla. Coincide con el patrón de las tablas protegidas.
alter table public.writing_prompts enable row level security;

-- Conectar la referencia que ya existía en writing_submissions.prompt_id.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'writing_submissions_prompt_id_fkey'
      and table_name = 'writing_submissions'
  ) then
    alter table public.writing_submissions
      add constraint writing_submissions_prompt_id_fkey
      foreign key (prompt_id) references public.writing_prompts(id);
  end if;
end $$;
