create extension if not exists pgcrypto;

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  payment_method text not null default 'mpesa' check (payment_method in ('mpesa', 'bank', 'cash')),
  phone text,
  checkout_request_id text,
  merchant_request_id text,
  receipt_number text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method text not null default 'mpesa' check (method in ('mpesa')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  phone text not null,
  checkout_request_id text,
  merchant_request_id text,
  receipt_number text,
  callback_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_user_status_idx
  on public.sales (user_id, status, created_at desc);

create index if not exists sales_checkout_idx
  on public.sales (checkout_request_id);

create index if not exists payments_sale_idx
  on public.payments (sale_id, status);

create index if not exists payments_checkout_idx
  on public.payments (checkout_request_id);

alter table public.sales enable row level security;
alter table public.payments enable row level security;

revoke all on public.sales, public.payments from anon;

create policy if not exists "Users can read their own sales"
  on public.sales for select to authenticated
  using ((select auth.uid()) = user_id);

create policy if not exists "Users can read their own payments"
  on public.payments for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.apply_mpesa_callback_result(
  p_payment_id uuid,
  p_sale_id uuid,
  p_checkout_request_id text,
  p_merchant_request_id text,
  p_amount numeric,
  p_phone text,
  p_receipt_number text,
  p_status text,
  p_callback_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status = 'paid' then
    update public.payments
      set status = 'paid',
          receipt_number = coalesce(p_receipt_number, receipt_number),
          callback_payload = p_callback_payload,
          updated_at = now()
    where id = p_payment_id
      and checkout_request_id = p_checkout_request_id
      and merchant_request_id = p_merchant_request_id
      and amount = p_amount
      and phone = p_phone
      and status in ('pending', 'failed');

    update public.sales
      set status = 'paid',
          receipt_number = coalesce(p_receipt_number, receipt_number),
          updated_at = now(),
          paid_at = now()
    where id = p_sale_id
      and status = 'pending';
  elsif p_status = 'failed' then
    update public.payments
      set status = 'failed',
          callback_payload = p_callback_payload,
          updated_at = now()
    where id = p_payment_id and status in ('pending', 'failed');

    update public.sales
      set status = 'failed',
          updated_at = now()
    where id = p_sale_id and status in ('pending', 'failed');
  end if;
end;
$$;

grant select on public.sales to authenticated;
grant select on public.payments to authenticated;
grant execute on function public.apply_mpesa_callback_result(uuid, uuid, text, text, numeric, text, text, text, jsonb) to service_role;
