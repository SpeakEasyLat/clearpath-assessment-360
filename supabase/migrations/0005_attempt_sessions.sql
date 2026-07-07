-- Sesiones de attempt: emitidas por la Edge Function "login" tras validar un access_code.
-- El frontend guarda este token (no el access_code) y lo manda en cada llamada posterior
-- (enviar respuesta, pedir audio, etc.) para que las demas Edge Functions sepan que
-- attempt/estudiante esta operando, sin tener que volver a mandar el access_code cada vez.
-- Igual que el resto de las tablas: RLS habilitado y SIN policies -- solo accesible por
-- Edge Functions via service_role (que bypassea RLS). anon/authenticated no tienen acceso
-- directo a esta tabla en ningun caso.
create table attempt_sessions (
    token uuid primary key default gen_random_uuid(),
    attempt_id uuid not null references attempts(id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '4 hours')
  );

create index attempt_sessions_attempt_id_idx on attempt_sessions (attempt_id);

alter table attempt_sessions enable row level security;
