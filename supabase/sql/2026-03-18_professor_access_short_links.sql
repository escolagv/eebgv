create table if not exists public.professor_access_short_links (
  code text primary key,
  action_link text not null,
  email text not null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz null
);

create index if not exists professor_access_short_links_expires_at_idx
  on public.professor_access_short_links (expires_at);

alter table public.professor_access_short_links enable row level security;

