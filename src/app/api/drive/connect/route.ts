// =============================================================================
// Inicia el OAuth de Google Drive
// =============================================================================
// Redirige al usuario autenticado al consentimiento de Google. Protege con un
// `state` aleatorio guardado en cookie httpOnly (anti-CSRF). El upload a Drive
// es server-side, asi que NO requiere tocar el CSP del navegador.
// =============================================================================

import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { buildAuthUrl, isDriveConfigured } from '@/lib/drive/oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.nextUrl.origin))

  if (!isDriveConfigured()) {
    return NextResponse.redirect(new URL('/dashboard/ajustes?drive=noconfig', req.nextUrl.origin))
  }

  const state = randomUUID()
  const redirectUri = new URL('/api/drive/callback', req.nextUrl.origin).toString()

  const cookieStore = await cookies()
  cookieStore.set('drive_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  })

  return NextResponse.redirect(buildAuthUrl(redirectUri, state))
}
