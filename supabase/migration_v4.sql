-- ============================================================================
-- AmitVet · מיגרציה v4 — חיוב וחשבוניות (Billing)
-- הריצו ב-Supabase → SQL Editor (idempotent — בטוח להריץ שוב).
-- מוסיף: מחירון שירותים, חשבוניות, ופריטי חשבונית — עם RLS.
-- ============================================================================

create sequence if not exists public.invoice_seq start 1001;

-- ---------- מחירון שירותים ----------
create table if not exists public.services (
  id         bigint generated always as identity primary key,
  name       text not null,
  price      numeric not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- חשבוניות ----------
create table if not exists public.invoices (
  id             bigint generated always as identity primary key,
  number         text not null unique default ('INV-' || lpad(nextval('public.invoice_seq')::text, 5, '0')),
  client_id      uuid not null references public.profiles(id) on delete cascade,
  pet_id         bigint references public.pets(id) on delete set null,
  appointment_id bigint references public.appointments(id) on delete set null,
  status         text not null default 'draft' check (status in ('draft','sent','paid','void')),
  issued_at      date not null default current_date,
  due_date       date,
  currency       text not null default 'ILS',
  tax_rate       numeric not null default 0,    -- אחוז מע״מ (0 אם פטור)
  subtotal       numeric not null default 0,
  tax_amount     numeric not null default 0,
  total          numeric not null default 0,
  notes          text,
  created_by     uuid references public.profiles(id) on delete set null,
  paid_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists idx_invoices_client on public.invoices(client_id);
create index if not exists idx_invoices_status on public.invoices(status);

-- ---------- פריטי חשבונית ----------
create table if not exists public.invoice_items (
  id          bigint generated always as identity primary key,
  invoice_id  bigint not null references public.invoices(id) on delete cascade,
  description text not null,
  qty         numeric not null default 1,
  unit_price  numeric not null default 0,
  line_total  numeric not null default 0
);
create index if not exists idx_invoice_items_inv on public.invoice_items(invoice_id);

-- ---------- RLS ----------
alter table public.services       enable row level security;
alter table public.invoices       enable row level security;
alter table public.invoice_items  enable row level security;

-- services: לווטרינר בלבד.
drop policy if exists services_all on public.services;
create policy services_all on public.services for all using (public.is_vet()) with check (public.is_vet());

-- invoices: הווטרינר מנהל הכל; הלקוח רואה את החשבוניות שלו בלבד.
drop policy if exists inv_select on public.invoices;
create policy inv_select on public.invoices for select using (client_id = auth.uid() or public.is_vet());
drop policy if exists inv_insert on public.invoices;
create policy inv_insert on public.invoices for insert with check (public.is_vet());
drop policy if exists inv_update on public.invoices;
create policy inv_update on public.invoices for update using (public.is_vet());
drop policy if exists inv_delete on public.invoices;
create policy inv_delete on public.invoices for delete using (public.is_vet());

-- invoice_items: נקרא אם החשבונית גלויה; כתיבה לווטרינר בלבד.
drop policy if exists invit_select on public.invoice_items;
create policy invit_select on public.invoice_items for select using (
  exists (select 1 from public.invoices i where i.id = invoice_items.invoice_id and (i.client_id = auth.uid() or public.is_vet())));
drop policy if exists invit_insert on public.invoice_items;
create policy invit_insert on public.invoice_items for insert with check (public.is_vet());
drop policy if exists invit_update on public.invoice_items;
create policy invit_update on public.invoice_items for update using (public.is_vet());
drop policy if exists invit_delete on public.invoice_items;
create policy invit_delete on public.invoice_items for delete using (public.is_vet());
