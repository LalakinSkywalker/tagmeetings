// =============================================================================
// PRP-TT-V2 Fase 6C — OAuth 2.0 de Google (Drive) — scope MINIMO drive.file
// =============================================================================
// Helpers puros de OAuth contra Google (fetch directo, sin la libreria pesada
// googleapis — menos superficie/supply-chain). Scope unico: drive.file (la app
// solo ve/gestiona los archivos que ELLA crea, nunca el resto del Drive).
// SOLO server-side.
// =============================================================================

import 'server-only'

/** Scope minimo: solo archivos creados por la app. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

function clientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en el entorno.')
  }
  return { clientId, clientSecret }
}

/** True si el proyecto tiene las credenciales de Google configuradas. */
export function isDriveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

/** URL de consentimiento de Google a la que se redirige al usuario. */
export function buildAuthUrl(redirectUri: string, state: string): string {
  const { clientId } = clientCreds()
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline', // pide refresh_token
    // 'select_account' deja al usuario elegir/cambiar de cuenta de Google;
    // 'consent' fuerza emitir refresh_token siempre.
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_ENDPOINT}?${p.toString()}`
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type: string
}

/** Intercambia el `code` del callback por tokens. */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = clientCreds()
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) {
    throw new Error(`Intercambio de token con Google fallo (${res.status}).`)
  }
  return res.json()
}

/** Renueva el access_token usando el refresh_token (no devuelve refresh nuevo). */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = clientCreds()
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    throw new Error(`Renovacion de token con Google fallo (${res.status}).`)
  }
  return res.json()
}
