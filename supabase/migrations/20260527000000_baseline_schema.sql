-- ============================================================================
-- TagMeetings — Baseline schema (self-host BYOK)
-- ----------------------------------------------------------------------------
-- Reconstruido del schema REAL de produccion (2026-06-13). Funcionalmente
-- identico al estado vivo: 11 tablas, RLS, 5 funciones, triggers, indices
-- (incluido el indice vectorial HNSW y el GIN de busqueda), y el bucket de
-- Storage. Pensado para aplicarse contra un proyecto Supabase NUEVO y vacio
-- (via `supabase db push`, `supabase db reset`, o el instalador `setup.mjs`).
--
-- Idempotente donde el motor lo permite: re-ejecutarlo no rompe una BD ya
-- migrada. Los comentarios internos del schema original (notas de PRPs) se
-- omitieron a proposito; no afectan el funcionamiento.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTENSIONES
-- ----------------------------------------------------------------------------
create extension if not exists vector   with schema extensions;  -- pgvector (embeddings + HNSW)
create extension if not exists pgcrypto with schema extensions;  -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- 2. TABLAS  (orden por dependencias de llaves foraneas)
-- ----------------------------------------------------------------------------

-- 2.1 profiles  (1:1 con auth.users)
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2.2 proyectos
create table if not exists public.proyectos (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles (id) on delete cascade,
  nombre                   text not null,
  descripcion              text not null default '',
  color                    text,
  drive_folder_id          text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  memoria_resumen          text,
  memoria_generada_at      timestamptz,
  memoria_sesiones_count   integer not null default 0,
  pendientes_generados_at  timestamptz,
  pendientes_sesiones_count integer
);

-- 2.3 transcripciones  (sesion)
create table if not exists public.transcripciones (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles (id) on delete cascade,
  titulo                      text not null,
  template_id                 text not null,
  estado                      text not null default 'pendiente'
                                check (estado = any (array['pendiente','transcribiendo','analizando','indexando','completado','error'])),
  duracion_ms                 integer,
  idioma                      text default 'es-MX',
  audio_path                  text not null,
  audio_size_bytes            bigint,
  audio_mime                  text,
  transcription_provider      text default 'deepgram-nova-3',
  raw_text                    text,
  segments                    jsonb,
  analisis                    jsonb,
  categoria                   text,
  cost_usd_total              numeric,
  error_message               text,
  created_at                  timestamptz not null default now(),
  completed_at                timestamptz,
  updated_at                  timestamptz not null default now(),
  search_vector               tsvector generated always as (
                                setweight(to_tsvector('spanish', coalesce(titulo, '')), 'A') ||
                                setweight(to_tsvector('spanish', coalesce(raw_text, '')), 'B')
                              ) stored,
  callback_secret             text,
  speaker_names               jsonb not null default '{}'::jsonb,
  idioma_detectado            text,
  traducido_a                 text,
  raw_text_traducido          text,
  segments_traducido          jsonb,
  participantes_esperados     jsonb,
  num_speakers_esperados      integer,
  es_multifuente              boolean not null default false,
  proyecto_id                 uuid references public.proyectos (id) on delete set null,
  modo_analisis               text not null default 'rapido'
                                check (modo_analisis = any (array['rapido','profundo'])),
  archivado_en                timestamptz,
  drive_folder_id             text,
  traducir_a                  text,
  intentos                    integer not null default 0,
  texto_editado_en            timestamptz,
  audio_liberado_en           timestamptz,
  aviso_expiracion_enviado_en timestamptz
);

-- 2.4 transcripcion_chunks  (vectores RAG)
create table if not exists public.transcripcion_chunks (
  id               uuid primary key default gen_random_uuid(),
  transcripcion_id uuid not null references public.transcripciones (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  chunk_index      integer not null,
  text             text not null,
  start_ms         integer not null,
  end_ms           integer not null,
  embedding        vector(1536),
  created_at       timestamptz not null default now(),
  speaker_id       integer
);

-- 2.5 transcripcion_fuentes  (fuentes multi-archivo)
create table if not exists public.transcripcion_fuentes (
  id               uuid primary key default gen_random_uuid(),
  transcripcion_id uuid not null references public.transcripciones (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  orden            integer not null default 0,
  tipo             text not null check (tipo = any (array['audio','video','pdf','doc','texto'])),
  nombre_archivo   text,
  audio_path       text,
  mime             text,
  size_bytes       bigint,
  estado           text not null default 'pendiente'
                     check (estado = any (array['pendiente','subido','transcribiendo','transcrito','error'])),
  request_id       text,
  callback_secret  text,
  raw_text         text,
  segments         jsonb,
  texto_extraido   text,
  duracion_ms      integer,
  idioma_detectado text,
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  intentos         integer not null default 0,
  audio_liberado_en timestamptz,
  archivado_en     timestamptz
);

-- 2.6 ask_queries  (chat con citas)
create table if not exists public.ask_queries (
  id               uuid primary key default gen_random_uuid(),
  transcripcion_id uuid references public.transcripciones (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  question         text not null,
  answer           text not null,
  citations        jsonb,
  model_used       text,
  cost_usd         numeric,
  created_at       timestamptz not null default now(),
  proyecto_id      uuid references public.proyectos (id) on delete cascade,
  constraint ask_queries_scope_chk check (transcripcion_id is not null or proyecto_id is not null)
);

-- 2.7 plantillas_usuario
create table if not exists public.plantillas_usuario (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  nombre               text not null,
  descripcion          text not null default '',
  prompt_system        text not null,
  prompt_user_template text not null,
  output_schema        jsonb not null,
  campos_spec          jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- 2.8 pendientes  (tablero vivo del proyecto)
create table if not exists public.pendientes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  proyecto_id      uuid not null references public.proyectos (id) on delete cascade,
  transcripcion_id uuid references public.transcripciones (id) on delete set null,
  texto            text not null,
  owner            text,
  due_date         date,
  estado           text not null default 'pendiente'
                     check (estado = any (array['pendiente','en_curso','hecho'])),
  origen           text not null default 'ia'
                     check (origen = any (array['ia','usuario'])),
  estado_origen    text not null default 'ia'
                     check (estado_origen = any (array['ia','usuario'])),
  nota_ia          text,
  dedup_key        text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- 2.9 drive_connections  (OAuth Google Drive — opcional)
create table if not exists public.drive_connections (
  user_id                 uuid primary key references public.profiles (id) on delete cascade,
  access_token_encrypted  text not null,
  refresh_token_encrypted text,
  expires_at              timestamptz,
  scope                   text,
  connected_email         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- 2.10 user_settings  (config 1:1 por usuario)
create table if not exists public.user_settings (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  idioma_default          text not null default 'es-MX',
  traducir_a              text default 'es-MX',
  modo_analisis_default   text not null default 'rapido'
                            check (modo_analisis_default = any (array['rapido','profundo'])),
  template_id_default     text,
  brand_logo_path         text,
  brand_color_primario    text,
  brand_color_secundario  text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  retencion_audio_dias    integer,
  respaldo_modo           text not null default 'off'
                            check (respaldo_modo = any (array['auto','manual','off'])),
  aviso_expiracion_activo boolean not null default true,
  aviso_expiracion_dias   integer not null default 3
);

-- 2.11 push_subscriptions  (web push — opcional)
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  device_name text,
  browser     text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint push_subscriptions_user_id_endpoint_key unique (user_id, endpoint)
);

-- ----------------------------------------------------------------------------
-- 3. INDICES
-- ----------------------------------------------------------------------------
create index if not exists idx_ask_queries_proyecto on public.ask_queries using btree (proyecto_id) where (proyecto_id is not null);
create index if not exists idx_ask_transcripcion    on public.ask_queries using btree (transcripcion_id, created_at desc);

create index if not exists pendientes_proyecto_idx   on public.pendientes using btree (proyecto_id);
create index if not exists pendientes_user_idx       on public.pendientes using btree (user_id);

create index if not exists plantillas_usuario_user_idx on public.plantillas_usuario using btree (user_id, created_at desc);

create index if not exists proyectos_user_id_idx on public.proyectos using btree (user_id);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions using btree (user_id);

create index if not exists idx_chunks_embedding        on public.transcripcion_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists idx_chunks_transcripcion_id on public.transcripcion_chunks using btree (transcripcion_id);

create index if not exists transcripcion_fuentes_transcripcion_idx on public.transcripcion_fuentes using btree (transcripcion_id, orden);

create unique index if not exists idx_transcripciones_callback_secret on public.transcripciones using btree (callback_secret) where (callback_secret is not null);
create index if not exists idx_transcripciones_categoria   on public.transcripciones using btree (categoria);
create index if not exists idx_transcripciones_created_at  on public.transcripciones using btree (created_at desc);
create index if not exists idx_transcripciones_user_id     on public.transcripciones using btree (user_id);
create index if not exists transcripciones_proyecto_id_idx on public.transcripciones using btree (proyecto_id);
create index if not exists transcripciones_search_vector_idx on public.transcripciones using gin (search_vector);
create index if not exists transcripciones_user_created_idx  on public.transcripciones using btree (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 4. FUNCIONES  (despues de las tablas: las SQL validan su cuerpo al crearse)
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path to ''
as $function$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$function$;

create or replace function public.tagtranscriptor_set_updated_at()
  returns trigger
  language plpgsql
  security definer
  set search_path to ''
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create or replace function public.search_chunks(
  p_transcripcion_id uuid,
  p_query_embedding vector,
  p_match_count integer default 8
)
  returns table(chunk_id uuid, text text, start_ms integer, end_ms integer, speaker_id integer, similarity real)
  language sql
  set search_path to ''
as $function$
  select
    c.id,
    c.text,
    c.start_ms,
    c.end_ms,
    c.speaker_id,
    (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::real as similarity
  from public.transcripcion_chunks c
  where c.transcripcion_id = p_transcripcion_id
    and c.user_id = auth.uid()
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit greatest(1, least(p_match_count, 50));
$function$;

create or replace function public.search_chunks_proyecto(
  p_proyecto_id uuid,
  p_query_embedding vector,
  p_match_count integer default 12
)
  returns table(chunk_id uuid, transcripcion_id uuid, titulo text, text text, start_ms integer, end_ms integer, speaker_id integer, similarity real)
  language sql
  set search_path to ''
as $function$
  select
    c.id,
    c.transcripcion_id,
    t.titulo,
    c.text,
    c.start_ms,
    c.end_ms,
    c.speaker_id,
    (1 - (c.embedding operator(extensions.<=>) p_query_embedding))::real as similarity
  from public.transcripcion_chunks c
  join public.transcripciones t on t.id = c.transcripcion_id
  where t.proyecto_id = p_proyecto_id
    and c.user_id = auth.uid()
  order by c.embedding operator(extensions.<=>) p_query_embedding
  limit greatest(1, least(p_match_count, 50));
$function$;

-- Hardening opcional: auto-habilita RLS en cualquier tabla nueva de `public`.
create or replace function public.rls_auto_enable()
  returns event_trigger
  language plpgsql
  security definer
  set search_path to 'pg_catalog'
as $function$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
    if cmd.schema_name is not null and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog','information_schema')
       and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    end if;
  end loop;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 5. TRIGGERS
-- ----------------------------------------------------------------------------

-- 5.1 Crear profile al registrarse un usuario (sobre auth.users).
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5.2 updated_at automatico.
drop trigger if exists trg_transcripciones_updated_at on public.transcripciones;
create trigger trg_transcripciones_updated_at
  before update on public.transcripciones
  for each row execute function public.tagtranscriptor_set_updated_at();

drop trigger if exists trg_transcripcion_fuentes_updated_at on public.transcripcion_fuentes;
create trigger trg_transcripcion_fuentes_updated_at
  before update on public.transcripcion_fuentes
  for each row execute function public.tagtranscriptor_set_updated_at();

-- 5.3 Event trigger de auto-RLS (requiere rol con permisos; tolerante a fallo).
do $$
begin
  begin
    execute 'drop event trigger if exists ensure_rls';
    execute $et$
      create event trigger ensure_rls
      on ddl_command_end
      when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      execute function public.rls_auto_enable()
    $et$;
  exception when insufficient_privilege or others then
    raise notice 'ensure_rls no creado (permisos insuficientes); las tablas de este baseline ya tienen RLS habilitado explicitamente.';
  end;
end $$;

-- ----------------------------------------------------------------------------
-- 6. RLS  (habilitar + politicas; cada usuario solo ve y toca lo suyo)
-- ----------------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.proyectos             enable row level security;
alter table public.transcripciones       enable row level security;
alter table public.transcripcion_chunks  enable row level security;
alter table public.transcripcion_fuentes enable row level security;
alter table public.ask_queries           enable row level security;
alter table public.plantillas_usuario    enable row level security;
alter table public.pendientes            enable row level security;
alter table public.drive_connections     enable row level security;
alter table public.user_settings         enable row level security;
alter table public.push_subscriptions    enable row level security;

-- profiles
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles
  for select to public using (auth.uid() = id);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update to public using (auth.uid() = id);

-- proyectos
drop policy if exists proyectos_self_all on public.proyectos;
create policy proyectos_self_all on public.proyectos
  for all to public using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- transcripciones
drop policy if exists transcripciones_self_all on public.transcripciones;
create policy transcripciones_self_all on public.transcripciones
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- transcripcion_chunks
drop policy if exists chunks_self_read on public.transcripcion_chunks;
create policy chunks_self_read on public.transcripcion_chunks
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists chunks_self_insert on public.transcripcion_chunks;
create policy chunks_self_insert on public.transcripcion_chunks
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists chunks_self_delete on public.transcripcion_chunks;
create policy chunks_self_delete on public.transcripcion_chunks
  for delete to authenticated using (auth.uid() = user_id);

-- transcripcion_fuentes
drop policy if exists transcripcion_fuentes_select_own on public.transcripcion_fuentes;
create policy transcripcion_fuentes_select_own on public.transcripcion_fuentes
  for select to public using (auth.uid() = user_id);
drop policy if exists transcripcion_fuentes_insert_own on public.transcripcion_fuentes;
create policy transcripcion_fuentes_insert_own on public.transcripcion_fuentes
  for insert to public with check (auth.uid() = user_id);
drop policy if exists transcripcion_fuentes_update_own on public.transcripcion_fuentes;
create policy transcripcion_fuentes_update_own on public.transcripcion_fuentes
  for update to public using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists transcripcion_fuentes_delete_own on public.transcripcion_fuentes;
create policy transcripcion_fuentes_delete_own on public.transcripcion_fuentes
  for delete to public using (auth.uid() = user_id);

-- ask_queries
drop policy if exists ask_self_all on public.ask_queries;
create policy ask_self_all on public.ask_queries
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- plantillas_usuario
drop policy if exists plantillas_usuario_select_own on public.plantillas_usuario;
create policy plantillas_usuario_select_own on public.plantillas_usuario
  for select to public using (auth.uid() = user_id);
drop policy if exists plantillas_usuario_insert_own on public.plantillas_usuario;
create policy plantillas_usuario_insert_own on public.plantillas_usuario
  for insert to public with check (auth.uid() = user_id);
drop policy if exists plantillas_usuario_update_own on public.plantillas_usuario;
create policy plantillas_usuario_update_own on public.plantillas_usuario
  for update to public using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists plantillas_usuario_delete_own on public.plantillas_usuario;
create policy plantillas_usuario_delete_own on public.plantillas_usuario
  for delete to public using (auth.uid() = user_id);

-- pendientes
drop policy if exists pendientes_self_all on public.pendientes;
create policy pendientes_self_all on public.pendientes
  for all to public using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- drive_connections
drop policy if exists drive_connections_self_all on public.drive_connections;
create policy drive_connections_self_all on public.drive_connections
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- user_settings
drop policy if exists user_settings_self_all on public.user_settings;
create policy user_settings_self_all on public.user_settings
  for all to public using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- push_subscriptions
drop policy if exists push_subscriptions_self_all on public.push_subscriptions;
create policy push_subscriptions_self_all on public.push_subscriptions
  for all to public using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 7. STORAGE  (bucket privado de audios; el audio grande vive en R2, este
--    bucket queda para compatibilidad. Cada usuario solo accede su carpeta.)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'audios', 'audios', false, 2147483648,
  array['audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/webm','audio/ogg',
        'audio/flac','audio/x-m4a','audio/aac','video/mp4','video/webm',
        'video/quicktime','video/x-matroska']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists audios_self_read on storage.objects;
create policy audios_self_read on storage.objects
  for select to authenticated
  using (bucket_id = 'audios' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists audios_self_insert on storage.objects;
create policy audios_self_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audios' and (storage.foldername(name))[1] = (select auth.uid()::text));

-- ============================================================================
-- Fin del baseline. Una BD Supabase nueva queda funcionalmente identica a prod.
-- ============================================================================
