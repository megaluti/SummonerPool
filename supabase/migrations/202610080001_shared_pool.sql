create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create or replace function public.sync_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, public.profiles.display_name);
  return new;
end;
$$;

create trigger auth_user_profile_sync
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.sync_profile();

create table public.pools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.pool_members (
  pool_id uuid not null references public.pools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (pool_id, user_id)
);

create or replace function public.is_pool_member(p_pool_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pool_members
    where pool_id = p_pool_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_pool_admin(p_pool_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pool_members
    where pool_id = p_pool_id and user_id = auth.uid() and role = 'admin'
  );
$$;

create table public.pool_invitations (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role = 'member'),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id)
);

create table public.decks (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (pool_id, id)
);

create table public.copies (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  card_id text not null,
  card_name text not null,
  set_id text not null default '',
  image_url text not null default '',
  collector_number integer,
  rarity text not null default '',
  owner_id uuid not null,
  holder_id uuid not null,
  deck_id uuid,
  created_at timestamptz not null default now(),
  foreign key (pool_id, owner_id) references public.pool_members(pool_id, user_id),
  foreign key (pool_id, holder_id) references public.pool_members(pool_id, user_id),
  foreign key (pool_id, deck_id) references public.decks(pool_id, id),
  check (collector_number is null or collector_number >= 0)
);
create index copies_pool_card_idx on public.copies(pool_id, card_id);
create index copies_pool_owner_idx on public.copies(pool_id, owner_id);
create index copies_pool_holder_idx on public.copies(pool_id, holder_id);
create index copies_pool_deck_idx on public.copies(pool_id, deck_id) where deck_id is not null;

create table public.deck_requests (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  deck_id uuid not null,
  card_id text not null,
  card_name text not null,
  quantity integer not null check (quantity between 1 and 200),
  created_at timestamptz not null default now(),
  unique (deck_id, card_id),
  foreign key (pool_id, deck_id) references public.decks(pool_id, id) on delete cascade
);

create table public.loan_requests (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  copy_id uuid not null references public.copies(id) on delete cascade,
  from_holder uuid not null,
  to_holder uuid not null,
  return_from uuid,
  return_to uuid,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'return_pending', 'returned', 'cancelled')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  returned_at timestamptz,
  foreign key (pool_id, from_holder) references public.pool_members(pool_id, user_id),
  foreign key (pool_id, to_holder) references public.pool_members(pool_id, user_id),
  foreign key (pool_id, return_from) references public.pool_members(pool_id, user_id),
  foreign key (pool_id, return_to) references public.pool_members(pool_id, user_id),
  check (from_holder <> to_holder)
);
create index loan_requests_pool_status_idx on public.loan_requests(pool_id, status);

create table public.audit_log (
  id bigint generated always as identity primary key,
  pool_id uuid not null references public.pools(id) on delete cascade,
  actor_id uuid references auth.users(id),
  copy_id uuid,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_pool_created_idx on public.audit_log(pool_id, created_at desc);

create or replace function public.record_copy_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (pool_id, actor_id, copy_id, event_type, details)
    values (new.pool_id, auth.uid(), new.id, 'copy_added', jsonb_build_object('card_name', new.card_name));
    return new;
  end if;
  if old.owner_id is distinct from new.owner_id then
    insert into public.audit_log (pool_id, actor_id, copy_id, event_type, details)
    values (new.pool_id, auth.uid(), new.id, 'ownership_transferred',
      jsonb_build_object('card_name', new.card_name, 'from', old.owner_id, 'to', new.owner_id));
  end if;
  if old.holder_id is distinct from new.holder_id then
    insert into public.audit_log (pool_id, actor_id, copy_id, event_type, details)
    values (new.pool_id, auth.uid(), new.id, 'holder_changed',
      jsonb_build_object('card_name', new.card_name, 'from', old.holder_id, 'to', new.holder_id));
  end if;
  if old.deck_id is distinct from new.deck_id then
    insert into public.audit_log (pool_id, actor_id, copy_id, event_type,
      details) values (new.pool_id, auth.uid(), new.id,
      case when new.deck_id is null then 'deck_deallocated' else 'deck_allocated' end,
      jsonb_build_object('card_name', new.card_name, 'from_deck', old.deck_id, 'to_deck', new.deck_id));
  end if;
  return new;
end;
$$;

create or replace function public.record_loan_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_copy_name text;
begin
  select card_name into v_copy_name from public.copies where id = new.copy_id;
  if tg_op = 'INSERT' then
    insert into public.audit_log (pool_id, actor_id, copy_id, event_type, details)
    values (new.pool_id, auth.uid(), new.copy_id, 'loan_handover_requested',
      jsonb_build_object('card_name', v_copy_name, 'from', new.from_holder, 'to', new.to_holder));
  elsif old.status is distinct from new.status then
    insert into public.audit_log (pool_id, actor_id, copy_id, event_type, details)
    values (new.pool_id, auth.uid(), new.copy_id, 'loan_' || new.status,
      jsonb_build_object('card_name', v_copy_name, 'status', new.status));
  end if;
  return new;
end;
$$;

create or replace function public.prevent_request_below_allocated()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_allocated integer;
begin
  if new.quantity < old.quantity then
    select count(*) into v_allocated from public.copies
      where deck_id = old.deck_id and card_id = old.card_id;
    if new.quantity < v_allocated then
      raise exception 'Requested quantity cannot be less than the number of allocated copies (%).', v_allocated;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.release_archived_deck_copies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'active' and new.status = 'archived' then
    update public.copies set deck_id = null where deck_id = new.id;
  end if;
  return new;
end;
$$;

create trigger copies_audit_insert after insert on public.copies
for each row execute function public.record_copy_change();
create trigger copies_audit_update after update of owner_id, holder_id, deck_id on public.copies
for each row execute function public.record_copy_change();
create trigger loan_requests_audit after insert or update of status on public.loan_requests
for each row execute function public.record_loan_change();
create trigger deck_requests_quantity_guard before update of quantity on public.deck_requests
for each row execute function public.prevent_request_below_allocated();
create trigger archived_deck_releases_copies after update of status on public.decks
for each row execute function public.release_archived_deck_copies();

create or replace function public.create_pool(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_pool_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(btrim(p_name)) not between 1 and 80 then raise exception 'Pool name must be 1–80 characters'; end if;
  insert into public.pools (name, created_by) values (btrim(p_name), auth.uid()) returning id into v_pool_id;
  insert into public.pool_members (pool_id, user_id, role) values (v_pool_id, auth.uid(), 'admin');
  return v_pool_id;
end;
$$;

create or replace function public.accept_pool_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_inv public.pool_invitations%rowtype; v_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  select * into v_inv from public.pool_invitations where id = p_invitation_id for update;
  if not found then raise exception 'Invitation not found'; end if;
  if v_inv.accepted_at is not null then raise exception 'Invitation has already been accepted'; end if;
  if v_inv.expires_at <= now() then raise exception 'Invitation has expired'; end if;
  if lower(v_inv.email) <> v_email then raise exception 'Sign in with the email address this invitation was sent to'; end if;
  insert into public.pool_members (pool_id, user_id, role) values (v_inv.pool_id, auth.uid(), v_inv.role)
    on conflict (pool_id, user_id) do nothing;
  update public.pool_invitations set accepted_at = now(), accepted_by = auth.uid() where id = p_invitation_id;
  return v_inv.pool_id;
end;
$$;

create or replace function public.add_card_copies(p_pool_id uuid, p_card jsonb, p_quantity integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_inserted integer;
begin
  if not public.is_pool_member(p_pool_id) then raise exception 'Pool membership required'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 200 then raise exception 'Quantity must be between 1 and 200'; end if;
  if nullif(p_card ->> 'card_id', '') is null or nullif(p_card ->> 'name', '') is null then raise exception 'Card ID and name are required'; end if;
  insert into public.copies (pool_id, card_id, card_name, set_id, image_url, collector_number, rarity, owner_id, holder_id)
  select p_pool_id, p_card ->> 'card_id', p_card ->> 'name',
    coalesce(p_card ->> 'set_id', ''), coalesce(p_card ->> 'image_url', ''),
    nullif(p_card ->> 'collector_number', '')::integer, coalesce(p_card ->> 'rarity', ''),
    auth.uid(), auth.uid()
  from generate_series(1, p_quantity);
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.transfer_copy_ownership(p_copy_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_copy public.copies%rowtype;
begin
  select * into v_copy from public.copies where id = p_copy_id for update;
  if not found or not public.is_pool_member(v_copy.pool_id) then raise exception 'Copy not found in an accessible pool'; end if;
  if not exists (select 1 from public.pool_members where pool_id = v_copy.pool_id and user_id = p_new_owner_id) then
    raise exception 'New owner must be a pool member';
  end if;
  update public.copies set owner_id = p_new_owner_id where id = p_copy_id;
  update public.loan_requests
    set status = case
          when (status = 'accepted' and p_new_owner_id = v_copy.holder_id)
            or (status = 'return_pending' and p_new_owner_id = return_from)
          then 'returned' else status end,
        return_to = case when status = 'return_pending' then p_new_owner_id else return_to end,
        returned_at = case
          when (status = 'accepted' and p_new_owner_id = v_copy.holder_id)
            or (status = 'return_pending' and p_new_owner_id = return_from)
          then now() else returned_at end
    where copy_id = p_copy_id
      and (status = 'accepted' or status = 'return_pending');
end;
$$;

create or replace function public.create_deck(p_pool_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_deck_id uuid;
begin
  if not public.is_pool_member(p_pool_id) then raise exception 'Pool membership required'; end if;
  if length(btrim(p_name)) not between 1 and 100 then raise exception 'Deck name must be 1–100 characters'; end if;
  insert into public.decks (pool_id, name, created_by) values (p_pool_id, btrim(p_name), auth.uid()) returning id into v_deck_id;
  return v_deck_id;
end;
$$;

create or replace function public.allocate_copy(p_copy_id uuid, p_deck_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_copy public.copies%rowtype; v_pool_id uuid; v_card_id text; v_requested integer; v_allocated integer;
begin
  select * into v_copy from public.copies where id = p_copy_id for update;
  if not found or not public.is_pool_member(v_copy.pool_id) then raise exception 'Copy not found in an accessible pool'; end if;
  if v_copy.deck_id is not null then raise exception 'Copy is already allocated'; end if;
  select pool_id into v_pool_id from public.decks where id = p_deck_id and status = 'active';
  if not found or v_pool_id <> v_copy.pool_id then raise exception 'Active deck must belong to the same pool'; end if;
  select card_id, quantity into v_card_id, v_requested from public.deck_requests
    where deck_id = p_deck_id and card_id = v_copy.card_id for update;
  if not found then raise exception 'Deck has not requested this card'; end if;
  select count(*) into v_allocated from public.copies where deck_id = p_deck_id and card_id = v_copy.card_id;
  if v_allocated >= v_requested then raise exception 'Requested quantity is already fully allocated'; end if;
  update public.copies set deck_id = p_deck_id where id = p_copy_id;
end;
$$;

create or replace function public.deallocate_copy(p_copy_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_copy public.copies%rowtype;
begin
  select * into v_copy from public.copies where id = p_copy_id for update;
  if not found or not public.is_pool_member(v_copy.pool_id) then raise exception 'Copy not found in an accessible pool'; end if;
  if v_copy.deck_id is null then raise exception 'Copy is not allocated'; end if;
  update public.copies set deck_id = null where id = p_copy_id;
end;
$$;

create or replace function public.request_loan_handover(p_copy_id uuid, p_to_holder uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_copy public.copies%rowtype; v_loan_id uuid;
begin
  select * into v_copy from public.copies where id = p_copy_id for update;
  if not found or not public.is_pool_member(v_copy.pool_id) then raise exception 'Copy not found in an accessible pool'; end if;
  if v_copy.holder_id <> auth.uid() then raise exception 'Only the current holder can request a handover'; end if;
  if p_to_holder = auth.uid() or not exists (select 1 from public.pool_members where pool_id = v_copy.pool_id and user_id = p_to_holder) then
    raise exception 'Recipient must be another member of this pool';
  end if;
  if exists (select 1 from public.loan_requests where copy_id = p_copy_id and status in ('pending', 'accepted', 'return_pending')) then
    raise exception 'This copy already has an active loan request';
  end if;
  insert into public.loan_requests (pool_id, copy_id, from_holder, to_holder)
    values (v_copy.pool_id, p_copy_id, auth.uid(), p_to_holder) returning id into v_loan_id;
  return v_loan_id;
end;
$$;

create or replace function public.confirm_loan_handover(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_loan public.loan_requests%rowtype; v_copy public.copies%rowtype;
begin
  select * into v_loan from public.loan_requests where id = p_loan_id for update;
  if not found or v_loan.to_holder <> auth.uid() or v_loan.status <> 'pending' then raise exception 'Pending handover for this member not found'; end if;
  select * into v_copy from public.copies where id = v_loan.copy_id for update;
  if v_copy.holder_id <> v_loan.from_holder then raise exception 'The recorded current holder has changed'; end if;
  update public.copies set holder_id = v_loan.to_holder where id = v_copy.id;
  update public.loan_requests set status = 'accepted', accepted_at = now() where id = p_loan_id;
  if v_copy.owner_id = v_loan.to_holder then
    update public.loan_requests set status = 'returned', returned_at = now() where id = p_loan_id;
  end if;
end;
$$;

create or replace function public.request_loan_return(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_loan public.loan_requests%rowtype; v_copy public.copies%rowtype;
begin
  select * into v_loan from public.loan_requests where id = p_loan_id for update;
  if not found or v_loan.status <> 'accepted' then raise exception 'Active loan not found'; end if;
  select * into v_copy from public.copies where id = v_loan.copy_id for update;
  if v_copy.holder_id <> auth.uid() then raise exception 'Only the current physical holder can request return'; end if;
  if v_copy.owner_id = auth.uid() then raise exception 'The owner already holds this copy'; end if;
  update public.loan_requests set status = 'return_pending', return_from = auth.uid(), return_to = v_copy.owner_id where id = p_loan_id;
end;
$$;

create or replace function public.confirm_loan_return(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_loan public.loan_requests%rowtype; v_copy public.copies%rowtype;
begin
  select * into v_loan from public.loan_requests where id = p_loan_id for update;
  if not found or v_loan.status <> 'return_pending' or v_loan.return_to <> auth.uid() then raise exception 'Return confirmation for this owner not found'; end if;
  select * into v_copy from public.copies where id = v_loan.copy_id for update;
  if v_copy.holder_id <> v_loan.return_from or v_copy.owner_id <> auth.uid() then raise exception 'Current ownership or possession changed'; end if;
  update public.copies set holder_id = auth.uid() where id = v_copy.id;
  update public.loan_requests set status = 'returned', returned_at = now() where id = p_loan_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.pools enable row level security;
alter table public.pool_members enable row level security;
alter table public.pool_invitations enable row level security;
alter table public.copies enable row level security;
alter table public.decks enable row level security;
alter table public.deck_requests enable row level security;
alter table public.loan_requests enable row level security;
alter table public.audit_log enable row level security;

create policy profiles_select_shared on public.profiles for select to authenticated
using (id = auth.uid() or exists (
  select 1 from public.pool_members mine join public.pool_members theirs on theirs.pool_id = mine.pool_id
  where mine.user_id = auth.uid() and theirs.user_id = profiles.id
));
create policy pools_select_member on public.pools for select to authenticated using (public.is_pool_member(id));
create policy pools_update_admin on public.pools for update to authenticated using (public.is_pool_admin(id)) with check (public.is_pool_admin(id));
create policy members_select_peer on public.pool_members for select to authenticated using (public.is_pool_member(pool_id));
create policy invitations_select_admin on public.pool_invitations for select to authenticated using (public.is_pool_admin(pool_id));
create policy invitations_insert_admin on public.pool_invitations for insert to authenticated with check (public.is_pool_admin(pool_id) and created_by = auth.uid());
create policy copies_select_member on public.copies for select to authenticated using (public.is_pool_member(pool_id));
create policy decks_select_member on public.decks for select to authenticated using (public.is_pool_member(pool_id));
create policy decks_insert_member on public.decks for insert to authenticated with check (public.is_pool_member(pool_id) and created_by = auth.uid());
create policy decks_update_member on public.decks for update to authenticated using (public.is_pool_member(pool_id)) with check (public.is_pool_member(pool_id));
create policy requests_select_member on public.deck_requests for select to authenticated using (public.is_pool_member(pool_id));
create policy requests_insert_member on public.deck_requests for insert to authenticated with check (
  public.is_pool_member(deck_requests.pool_id) and exists(select 1 from public.decks d where d.id = deck_requests.deck_id and d.pool_id = deck_requests.pool_id and d.status = 'active')
);
create policy requests_update_member on public.deck_requests for update to authenticated using (public.is_pool_member(pool_id))
with check (public.is_pool_member(deck_requests.pool_id) and exists(select 1 from public.decks d where d.id = deck_requests.deck_id and d.pool_id = deck_requests.pool_id and d.status = 'active'));
create policy requests_delete_member on public.deck_requests for delete to authenticated using (public.is_pool_member(pool_id));
create policy loans_select_member on public.loan_requests for select to authenticated using (public.is_pool_member(pool_id));
create policy audit_select_member on public.audit_log for select to authenticated using (public.is_pool_member(pool_id));

revoke all on function public.sync_profile() from public, anon, authenticated;
revoke all on function public.record_copy_change() from public, anon, authenticated;
revoke all on function public.record_loan_change() from public, anon, authenticated;
revoke all on function public.prevent_request_below_allocated() from public, anon, authenticated;
revoke all on function public.release_archived_deck_copies() from public, anon, authenticated;
revoke all on function public.is_pool_member(uuid) from public, anon;
revoke all on function public.is_pool_admin(uuid) from public, anon;
grant execute on function public.is_pool_member(uuid), public.is_pool_admin(uuid) to authenticated;

revoke all on function public.create_pool(text) from public, anon;
revoke all on function public.accept_pool_invitation(uuid) from public, anon;
revoke all on function public.add_card_copies(uuid,jsonb,integer) from public, anon;
revoke all on function public.transfer_copy_ownership(uuid,uuid) from public, anon;
revoke all on function public.create_deck(uuid,text) from public, anon;
revoke all on function public.allocate_copy(uuid,uuid) from public, anon;
revoke all on function public.deallocate_copy(uuid) from public, anon;
revoke all on function public.request_loan_handover(uuid,uuid) from public, anon;
revoke all on function public.confirm_loan_handover(uuid) from public, anon;
revoke all on function public.request_loan_return(uuid) from public, anon;
revoke all on function public.confirm_loan_return(uuid) from public, anon;
grant execute on function public.create_pool(text), public.accept_pool_invitation(uuid),
  public.add_card_copies(uuid,jsonb,integer), public.transfer_copy_ownership(uuid,uuid),
  public.create_deck(uuid,text), public.allocate_copy(uuid,uuid), public.deallocate_copy(uuid),
  public.request_loan_handover(uuid,uuid), public.confirm_loan_handover(uuid),
  public.request_loan_return(uuid), public.confirm_loan_return(uuid) to authenticated;

grant select on public.profiles to authenticated;
grant select on public.pools, public.pool_members, public.copies, public.audit_log, public.loan_requests to authenticated;
grant select, insert on public.pool_invitations to authenticated;
grant select, insert, update on public.decks to authenticated;
grant select, insert, update, delete on public.deck_requests to authenticated;
