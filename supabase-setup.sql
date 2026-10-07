create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '',
  phone text not null default '',
  business text not null default '',
  business_type text not null default '',
  purpose text not null default 'Business',
  location text not null default '',
  notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  timestamp timestamptz not null default now(),
  description text not null,
  amount numeric(14, 2) not null check (amount > 0),
  channel text not null check (channel in ('mpesa', 'bank', 'cash')),
  type text not null check (type in ('income', 'expense')),
  created_at timestamptz not null default now()
);

create index if not exists ledger_entries_user_timestamp_idx
  on public.ledger_entries (user_id, timestamp desc);

alter table public.profiles enable row level security;
alter table public.ledger_entries enable row level security;

revoke all on public.profiles, public.ledger_entries from anon;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own ledger entries" on public.ledger_entries;
create policy "Users can read their own ledger entries"
  on public.ledger_entries for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own ledger entries" on public.ledger_entries;
create policy "Users can insert their own ledger entries"
  on public.ledger_entries for insert to authenticated
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.profiles to authenticated;
grant select, insert on public.ledger_entries to authenticated;
