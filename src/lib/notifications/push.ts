import 'server-only'

// =============================================================================
// Fase 9 — Motor de envio de notificaciones push (web-push + VAPID).
// =============================================================================
// `enviarPushAUsuario` lee las suscripciones del usuario (service client, bypassa
// RLS porque corre en background sin sesion: webhook / watchdog) y manda el push
// a cada dispositivo. Limpia las suscripciones muertas (404/410 = el browser ya
// no existe esa suscripcion). Best-effort por diseno: un fallo de envio NUNCA
// debe tumbar el pipeline de transcripcion que lo invoca.
//
// VAPID: NEXT_PUBLIC_VAPID_PUBLIC_KEY (publica) + VAPID_PRIVATE_KEY (secreta) +
// VAPID_SUBJECT (mailto de contacto). Se configuran una sola vez por proceso.
// =============================================================================

import webpush from 'web-push'
import { createServiceClient } from '@/lib/supabase/service'

let configured = false

/** Configura VAPID una vez por proceso. Devuelve false si faltan las llaves. */
function ensureVapid(): boolean {
  if (configured) return true
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!pub || !priv || !subject) {
    console.error('[push] faltan VAPID (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT); push opcional desactivado')
    return false
  }
  webpush.setVapidDetails(subject, pub, priv)
  configured = true
  return true
}

export interface PushPayload {
  title: string
  body: string
  /** Ruta a abrir al hacer click en la notificacion. Default: /dashboard. */
  url?: string
  /** Agrupa/colapsa notificaciones del mismo tema. */
  tag?: string
}

/**
 * Envia un push a TODOS los dispositivos suscritos de un usuario. Limpia las
 * suscripciones invalidadas por el push service. Nunca lanza: devuelve el conteo.
 */
export async function enviarPushAUsuario(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number }> {
  if (!ensureVapid()) return { sent: 0, failed: 0 }

  const supabase = createServiceClient()
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)

  if (!subs || subs.length === 0) return { sent: 0, failed: 0 }

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: payload.tag,
    data: { url: payload.url ?? '/dashboard' },
  })

  let sent = 0
  let failed = 0

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      )
      sent++
    } catch (err) {
      failed++
      const status = (err as { statusCode?: number })?.statusCode
      // 404 / 410 = suscripcion muerta: borrarla para no reintentar siempre.
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id)
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[push] envio fallo (status ${status ?? 'n/a'}): ${msg}`)
      }
    }
  }

  return { sent, failed }
}

/**
 * Aviso "tu transcripcion ya esta lista". Lee el titulo internamente para no
 * acoplar la firma del pipeline. Best-effort: cualquier error se traga (logea).
 */
export async function notificarTranscripcionLista(
  transcripcionId: string,
  userId: string,
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('transcripciones')
      .select('titulo')
      .eq('id', transcripcionId)
      .single()

    const titulo = (data?.titulo as string | undefined)?.trim()

    await enviarPushAUsuario(userId, {
      title: 'Tu transcripcion ya esta lista',
      body: titulo
        ? `"${titulo}" termino de procesarse. Toca para ver el analisis.`
        : 'Una transcripcion termino de procesarse. Toca para ver el analisis.',
      url: `/dashboard/transcripcion/${transcripcionId}`,
      tag: `transcripcion-${transcripcionId}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[push] notificarTranscripcionLista fallo: ${msg}`)
  }
}
