-- Performance: índices en las foreign keys sin cubrir (Supabase advisor 0001
-- unindexed_foreign_keys). Aditivos y reversibles; aceleran joins y los borrados
-- en cascada. Aplicado a producción 2026-06-15 (auditoría de performance).
CREATE INDEX IF NOT EXISTS idx_ask_queries_user_id
  ON public.ask_queries (user_id);
CREATE INDEX IF NOT EXISTS idx_pendientes_transcripcion_id
  ON public.pendientes (transcripcion_id);
CREATE INDEX IF NOT EXISTS idx_transcripcion_chunks_user_id
  ON public.transcripcion_chunks (user_id);
CREATE INDEX IF NOT EXISTS idx_transcripcion_fuentes_user_id
  ON public.transcripcion_fuentes (user_id);
