// =============================================================================
// Cliente Supabase con service_role para operaciones admin server-side.
// =============================================================================
// USAR SOLO desde server actions, route handlers o background jobs. Nunca
// importar desde Client Components — la SUPABASE_SERVICE_ROLE_KEY jamas debe
// llegar al cliente, salta TODAS las RLS policies.
//
// Casos de uso legitimos:
//   - Generar signed URLs de Storage (server actions)
// - Operaciones en webhooks publicos sin sesion de usuario
//   - Inserts a tablas que tienen RLS estricto y requieren bypass server-side
// =============================================================================

import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

/**
 * Devuelve un cliente Supabase autenticado con service_role.
 *
 * - Sin auto-refresh ni session persistente (es server-only, no hay browser).
 * - Cacheado por proceso para evitar re-creacion en cada request.
 *
 * @throws Error si faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.
 */
export function createServiceClient(): SupabaseClient {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error(
      'createServiceClient: faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en env.',
    )
  }

  cached = createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  return cached
}
