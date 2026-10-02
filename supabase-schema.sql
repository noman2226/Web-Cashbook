create table if not exists public.cashbook_workspaces (
  workspace_id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.cashbook_workspaces enable row level security;

create policy "Allow cashbook workspace access"
on public.cashbook_workspaces
for all
to anon
using (true)
with check (true);