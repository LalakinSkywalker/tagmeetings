// =============================================================================
// PRP-TT-V2 Fase 6C — Persistencia de la conexion de Drive (tokens cifrados)
// =============================================================================
// Guarda/lee los tokens OAuth CIFRADOS en drive_connections via service client
// (los tokens nunca tocan el navegador). Entrega un access_token valido,
// renovandolo con el refresh_token cuando expiro. SOLO server-side.
// =============================================================================

import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { decryptSecret, encryptSecret } from '@/lib/crypto/encrypt'
import { refreshAccessToken, type TokenResponse } from './oauth'

/**
 * Guarda (upsert) la conexion. Si no viene refresh_token, conserva el existente.
 * `email` solo se escribe cuando se provee (en el consent inicial); en los
 * refresh se omite para no pisarlo con null.
 */
export async function saveConnection(
  userId: string,
  t: TokenResponse,
  email?: string | null,
): Promise<void> {
  const admin = createServiceClient()
  const expiresAt = new Date(Date.now() + Math.max(0, t.expires_in - 60) * 1000).toISOString()
  const row: Record<string, unknown> = {
    user_id: userId,
    access_token_encrypted: encryptSecret(t.access_token),
    expires_at: expiresAt,
    scope: t.scope ?? null,
    updated_at: new Date().toISOString(),
  }
  // Google solo emite refresh_token en el consent inicial; en los refresh no
  // viene, y el upsert deja intacto el que ya estaba guardado.
  if (t.refresh_token) row.refresh_token_encrypted = encryptSecret(t.refresh_token)
  if (email) row.connected_email = email
  const { error } = await admin.from('drive_connections').upsert(row, { onConflict: 'user_id' })
  if (error) throw new Error(`No se pudo guardar la conexion de Drive: ${error.message}`)
}

/** Borra la conexion del usuario (desconectar). */
export async function deleteConnection(userId: string): Promise<void> {
  const admin = createServiceClient()
  await admin.from('drive_connections').delete().eq('user_id', userId)
}

/**
 * Devuelve un access_token valido para el usuario, o null si no hay conexion.
 * Renueva con el refresh_token si el actual expiro y reguarda el nuevo.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const admin = createServiceClient()
  const { data } = await admin
    .from('drive_connections')
    .select('access_token_encrypted, refresh_token_encrypted, expires_at')
    .eq('user_id', userId)
    .single()
  if (!data) return null

  const vigente =
    data.expires_at && new Date(data.expires_at as string).getTime() > Date.now()
  if (vigente) {
    try {
      return decryptSecret(data.access_token_encrypted as string)
    } catch {
      return null
    }
  }

  if (!data.refresh_token_encrypted) return null
  try {
    const refreshToken = decryptSecret(data.refresh_token_encrypted as string)
    const renewed = await refreshAccessToken(refreshToken)
    await saveConnection(userId, renewed) // sin refresh_token: conserva el viejo
    return renewed.access_token
  } catch {
    return null
  }
}
