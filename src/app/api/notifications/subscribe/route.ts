// =============================================================================
// Fase 9 — Suscripcion / baja de notificaciones push.
// =============================================================================
// POST   → registra (o refresca) la suscripcion web-push del dispositivo actual.
// DELETE → da de baja la suscripcion de este dispositivo (por endpoint).
//
// Seguridad: el user_id SIEMPRE sale de la sesion (auth.getUser()), NUNCA del
// body — asi nadie puede registrar una suscripcion a nombre de otro usuario. El
// insert usa el cliente SSR del usuario, asi la RLS `push_subscriptions_self_all`
// aplica de forma natural. El SW hace fetch same-origin, por lo que la cookie de
// sesion viaja incluso desde `pushsubscriptionchange`.
// =============================================================================

import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  let body: {
    subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    oldEndpoint?: string
    deviceInfo?: { deviceName?: string; browser?: string }
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body invalido' }, { status: 400 })
  }

  const sub = body.subscription
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ error: 'Suscripcion invalida' }, { status: 400 })
  }

  // Si el browser roto el endpoint (pushsubscriptionchange), limpiar el viejo.
  if (body.oldEndpoint && body.oldEndpoint !== sub.endpoint) {
    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', user.id)
      .eq('endpoint', body.oldEndpoint)
  }

  // Upsert por (user_id, endpoint): si ya existe refresca last_used_at, si no inserta.
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      device_name: body.deviceInfo?.deviceName ?? null,
      browser: body.deviceInfo?.browser ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,endpoint' },
  )

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  let endpoint: string | undefined
  try {
    endpoint = (await request.json())?.endpoint
  } catch {
    return NextResponse.json({ error: 'Body invalido' }, { status: 400 })
  }
  if (!endpoint) return NextResponse.json({ error: 'Falta endpoint' }, { status: 400 })

  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', endpoint)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
