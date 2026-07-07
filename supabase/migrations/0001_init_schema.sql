-- ClearPath Assessment 360 -- esquema inicial
-- Convenciones:
--   * Todo lo que el estudiante NO debe poder leer directamente (respuestas correctas,
--     rúbricas de writing, conteo de reproducciones de audio) vive en tablas que el
--     rol "anon" (usado por el frontend público en GitHub Pages) NO puede leer.
--   * El frontend solo habla con "student_facing_questions" (vista sin correct_answer)
--     y con Edge Functions (rol "service_role") para todo lo que implique lógica de
--     negocio: puntuar, decidir desbloqueos, emitir URLs firmadas de audio.

create extension if not exists "pgcrypto";

-- 1. Estudiantes -------------------------------------------------------------
create table students (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  access_code text not null unique, -- generado a mano por Diana tras confirmar el pago
  created_at timestamptz not null default now()
);

-- 2. Intentos (un "attempt" = una corrida completa del Assessment 360) -------
create table attempts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress','completed','abandoned')),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

-- 3. Banco de preguntas -------------------------------------------------------
-- module: 'nivel1_grammar' | 'nivel1_listening' | 'steps2' | 'oet_listening' | 'oet_reading'
create table question_bank (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  position int not null,          -- orden dentro del módulo (ej. 1-44 para grammar)
  cefr_level text,                -- 'A1'..'C1', null si no aplica (ej. STEPS2)
  question_text text not null,
  options jsonb not null,         -- array de strings, SIN incluir "I don't know the answer"
  correct_answer text not null,   -- *** nunca se expone a través de la vista pública ***
  audio_asset_id uuid,            -- null salvo listening
  created_at timestamptz not null default now()
);

-- Vista pública: lo único que el frontend (rol anon) puede leer.
-- OJO: nunca agregar correct_answer acá.
create view student_facing_questions as
  select id, module, position, cefr_level, question_text, options, audio_asset_id
  from question_bank;

-- 4. Respuestas del estudiante ------------------------------------------------
create table student_responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  question_id uuid not null references question_bank(id),
  selected_answer text,           -- null si el estudiante no respondió (ya no debería pasar, pero por las dudas)
  is_correct boolean,             -- lo calcula la Edge Function al recibir la respuesta, nunca el cliente
  answered_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- 5. Sub-scores por habilidad (grammar / listening / writing / reading) ------
create table sub_scores (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  skill text not null check (skill in ('grammar','listening','writing','steps2_reading')),
  raw_score int not null,
  max_score int not null,
  cefr_estimate text,             -- 'A1'..'C1', calculado server-side
  computed_at timestamptz not null default now(),
  unique (attempt_id, skill)
);

-- 6. Estado de desbloqueo -----------------------------------------------------
-- speaking_assessment_type resume a qué sesión en vivo (si alguna) quedó habilitado el
-- estudiante, según la regla que definió Diana:
--   * 'OET'     -> grammar+listening+writing (Nivel 1) superan el umbral B1 alto:
--                  se agenda el Speaking Assessment / roleplay OET completo.
--   * 'English' -> NO se alcanza OET Y el ceiling de reading + vocabulario médico de
--                  STEPS 2 tampoco llega a steps2_min_cefr_level: el estudiante queda
--                  en English Level y se agenda un Speaking Assessment breve en su lugar.
--   * null      -> no corresponde sesión en vivo por ahora (o bien porque el estudiante
--                  sigue con nivel para STEPS 2, o porque aún faltan sub-scores por rendir).
create table unlock_state (
  attempt_id uuid primary key references attempts(id) on delete cascade,
  steps2_unlocked boolean not null default true,  -- obligatorio para todos tras Nivel 1
  oet_unlocked boolean not null default false,    -- true solo si grammar+listening+writing >= umbral B1 alto
  speaking_assessment_type text check (speaking_assessment_type in ('English','OET')), -- null = sin sesión en vivo asignada todavía
  threshold_b1_alto int not null default 70,      -- % mínimo por sub-score para desbloquear OET (ajustable)
  steps2_min_cefr_level text not null default 'B2', -- nivel CEFR mínimo (ceiling de reading + vocab médico) para considerar "capacitado para STEPS 2"
  updated_at timestamptz not null default now()
);

-- 7. Audios (Nivel 1 listening, OET listening) -------------------------------
create table audio_assets (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  storage_path text not null,     -- ruta dentro de Supabase Storage (bucket privado), NUNCA una URL pública
  max_plays int not null default 1, -- imitando el formato OET: una sola reproducción
  created_at timestamptz not null default now()
);

-- Registro de reproducciones ya usadas, para hacer cumplir max_plays server-side
create table audio_play_log (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  audio_asset_id uuid not null references audio_assets(id),
  played_at timestamptz not null default now()
);

-- 8. Writing (consigna + evaluación automática contra rúbrica) ---------------
create table writing_submissions (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  prompt_id uuid not null,
  response_text text not null,
  ai_rubric_scores jsonb,         -- desglose por criterio (coherencia, rango gramatical, vocabulario, etc.)
  cefr_estimate text,
  submitted_at timestamptz not null default now()
);

-- 9. Speaking Assessment (sesión en vivo, no automática) ---------------------
-- Cubre los dos tipos de sesión en vivo que puede terminar agendando un estudiante:
--   * assessment_type = 'OET'     -> el roleplay OET completo (estudiante apto para OET).
--   * assessment_type = 'English' -> un Speaking Assessment breve, para quien no
--     alcanza ni el nivel de STEPS 2 (queda en English Level).
-- (este nombre reemplaza al antiguo "roleplay_bookings": ahora es una sola tabla para
-- cualquiera de las dos sesiones en vivo, distinguidas por assessment_type)
create table speaking_assessment_bookings (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  assessment_type text not null check (assessment_type in ('English','OET')),
  scheduled_at timestamptz,
  status text not null default 'pending' check (status in ('pending','scheduled','completed','no_show')),
  evaluator_score jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table students enable row level security;
alter table attempts enable row level security;
alter table question_bank enable row level security;
alter table student_responses enable row level security;
alter table sub_scores enable row level security;
alter table unlock_state enable row level security;
alter table audio_assets enable row level security;
alter table audio_play_log enable row level security;
alter table writing_submissions enable row level security;
alter table speaking_assessment_bookings enable row level security;

-- El rol "anon" (frontend público) NO tiene policies de acceso directo a nada
-- de esto salvo la vista student_facing_questions (las vistas heredan RLS de
-- las tablas base, así que le damos SELECT explícito solo a esa vista).
grant select on student_facing_questions to anon;

-- Todo lo demás (leer preguntas con correct_answer, insertar respuestas, calcular
-- sub_scores, decidir unlock_state, emitir URLs firmadas de audio_assets, guardar
-- writing_submissions) pasa EXCLUSIVAMENTE por Edge Functions usando el
-- service_role key, nunca expuesto al navegador del estudiante.
