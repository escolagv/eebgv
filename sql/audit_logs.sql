-- Tabela de auditoria para registrar ações administrativas
create table if not exists public.audit_logs (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    user_uid uuid null,
    action text not null,
    entity text not null,
    entity_id text null,
    details jsonb null
);

-- Recomendado: habilitar RLS e permitir inserts de usuários autenticados
alter table public.audit_logs enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'audit_logs'
          and policyname = 'audit_logs_insert_authenticated'
    ) then
        create policy audit_logs_insert_authenticated
        on public.audit_logs
        for insert
        to authenticated
        with check (true);
    end if;
end $$;
