-- El revoke de 0002 no alcanzo porque el EXECUTE estaba concedido a PUBLIC (rol implicito
-- del que anon/authenticated heredan por defecto en Postgres). Revocando de PUBLIC directamente.
revoke execute on function public.rls_auto_enable() from public;
