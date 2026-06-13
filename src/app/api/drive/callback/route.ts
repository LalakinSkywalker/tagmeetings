// =============================================================================
// PRP-TT-V2 Fase 6C — Callback del OAuth de Google Drive
// =============================================================================
// Verifica el `state` (anti-CSRF), intercambia el code por tokens, los CIFRA y
// guarda, y vuelve a Ajustes con un parametro de resultado.
// =============================================================================

import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { exchangeCode } from '@/lib/drive/oauth'
import { getDriveAccountEmail } from '@/lib/drive/client'
import { saveConnection } from '@/lib/drive/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function backTo(req: NextRequest, result: string) {
  return NextResponse.redirect(new URL(`/dashboard/ajustes?drive=${result}`, req.nextUrl.origin))
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.nextUrl.origin))

  const params = req.nextUrl.searchParams
  if (params.get('error')) return backTo(req, 'cancel')

  const code = params.get('code')
  const state = params.get('state')

  const cookieStore = await cookies()
  const expected = cookieStore.get('drive_oauth_state')?.value
  cookieStore.delete('drive_oauth_state')

  if (!code || !state || !expected || state !== expected) {
    return backTo(req, 'error')
  }

  try {
    const redirectUri = new URL('/api/drive/callback', req.nextUrl.origin).toString()
    const tokens = await exchangeCode(code, redirectUri)
    const email = await getDriveAccountEmail(tokens.access_token)
    await saveConnection(user.id, tokens, email)
    return backTo(req, 'ok')
  } catch {
    return backTo(req, 'error')
  }
}
