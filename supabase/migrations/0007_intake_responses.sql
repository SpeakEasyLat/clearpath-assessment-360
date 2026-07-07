-- Formulario de intake (no calificado) que el estudiante completa antes de arrancar
-- el examen. Guarda datos de contexto (nivel autopercibido, experiencia previa,
-- uso del idioma, disponibilidad horaria) que Diana usa para armar horarios y
-- reportes, NO para calcular ningun sub_score ni desbloqueo.
create table intake_responses (
  attempt_id uuid primary key references attempts(id) on delete cascade,
  self_perceived_level text not null,
  prior_experience text[] not null default '{}',
  time_since_regular_practice text not null,
  usage_frequency text not null,
  weekly_hours_available text not null,
  preferred_days text[] not null default '{}',
  preferred_time_slots text[] not null default '{}',
  submitted_at timestamptz not null default now()
  );

-- Mismo patron de seguridad que el resto de las tablas: RLS habilitado, sin
-- policies para anon/authenticated (bloqueado por default), service_role
-- accede via el grant global de la migracion 0006 (alter default privileges).
alter table intake_responses enable row level security;
