-- Bug descubierto probando la Edge Function "login": las tablas creadas en 0001 nunca
-- recibieron el grant de SELECT/INSERT/UPDATE/DELETE para service_role (solo tenia
-- REFERENCES/TRIGGER/TRUNCATE, heredado de los privilegios por default del schema).
-- service_role SI bypassea RLS, pero bypassear RLS no alcanza sin el grant de tabla
-- correspondiente -- son dos capas de permisos independientes en Postgres.
-- Esto rompia todo acceso desde las Edge Functions (error real: "permission denied for
-- table students"). anon/authenticated NO reciben nada aca: siguen limitados a lo que
-- ya se les dio explicitamente en 0001/0002 (student_facing_questions, columnas de
-- question_bank via la vista).
grant select, insert, update, delete
  on students, attempts, question_bank, student_responses, sub_scores,
     unlock_state, audio_assets, audio_play_log, writing_submissions,
     speaking_assessment_bookings, attempt_sessions
  to service_role;

-- Para que las tablas que se creen en migraciones futuras tambien le den automaticamente
-- este acceso a service_role sin tener que acordarse de repetir el grant a mano.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
