-- Migración: writing_submissions_unique_attempt_prompt
-- Permite que submit-writing haga upsert (si el estudiante reenvía, se actualiza
-- en vez de duplicar), igual que student_responses con (attempt_id, question_id).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'writing_submissions_attempt_prompt_key'
      and table_name = 'writing_submissions'
  ) then
    alter table public.writing_submissions
      add constraint writing_submissions_attempt_prompt_key
      unique (attempt_id, prompt_id);
  end if;
end $$;
