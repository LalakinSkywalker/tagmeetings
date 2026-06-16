-- Performance: envolver auth.uid() en (select auth.uid()) para que Postgres lo
-- evalúe UNA vez por query en vez de por fila (Supabase advisor 0003
-- auth_rls_initplan). Mismo predicado lógico → mismos permisos; solo cambia el
-- plan de ejecución. Se usa ALTER POLICY para preservar roles intactos.
-- Aplicado a producción 2026-06-15 (auditoría de performance).

ALTER POLICY "ask_self_all" ON public.ask_queries
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "drive_connections_self_all" ON public.drive_connections
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "pendientes_self_all" ON public.pendientes
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "plantillas_usuario_delete_own" ON public.plantillas_usuario
  USING ((select auth.uid()) = user_id);
ALTER POLICY "plantillas_usuario_insert_own" ON public.plantillas_usuario
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "plantillas_usuario_select_own" ON public.plantillas_usuario
  USING ((select auth.uid()) = user_id);
ALTER POLICY "plantillas_usuario_update_own" ON public.plantillas_usuario
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "Users can update own profile" ON public.profiles
  USING ((select auth.uid()) = id);
ALTER POLICY "Users can view own profile" ON public.profiles
  USING ((select auth.uid()) = id);

ALTER POLICY "proyectos_self_all" ON public.proyectos
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "push_subscriptions_self_all" ON public.push_subscriptions
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "chunks_self_delete" ON public.transcripcion_chunks
  USING ((select auth.uid()) = user_id);
ALTER POLICY "chunks_self_insert" ON public.transcripcion_chunks
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "chunks_self_read" ON public.transcripcion_chunks
  USING ((select auth.uid()) = user_id);

ALTER POLICY "transcripcion_fuentes_delete_own" ON public.transcripcion_fuentes
  USING ((select auth.uid()) = user_id);
ALTER POLICY "transcripcion_fuentes_insert_own" ON public.transcripcion_fuentes
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "transcripcion_fuentes_select_own" ON public.transcripcion_fuentes
  USING ((select auth.uid()) = user_id);
ALTER POLICY "transcripcion_fuentes_update_own" ON public.transcripcion_fuentes
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "transcripciones_self_all" ON public.transcripciones
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "user_settings_self_all" ON public.user_settings
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
