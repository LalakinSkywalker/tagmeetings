'use server'

// =============================================================================
// Server actions — Notificaciones push
// =============================================================================
// enviarPushDePrueba(): manda un push al usuario actual a TODOS sus dispositivos
// suscritos. Lo usa el boton "Enviar prueba" de Ajustes para confirmar de punta
// a punta que la suscripcion del dispositivo recibe notificaciones. El user_id
// sale de la sesion, nunca del cliente.
// =============================================================================

import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { enviarPushAUsuario } from '@/lib/notifications/push'

export async function enviarPushDePrueba(): Promise<{
  ok: boolean
  sent: number
  message?: string
}> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, sent: 0, message: 'No autenticado.' }

  const { sent } = await enviarPushAUsuario(user.id, {
    title: 'Notificación de prueba',
    body: 'Si ves esto, las notificaciones de TagMeetings ya funcionan en este dispositivo.',
    url: '/dashboard/ajustes',
    tag: 'prueba',
  })

  if (sent === 0) {
    return {
      ok: false,
      sent,
      message: 'No hay dispositivos suscritos en esta cuenta. Activa las notificaciones primero.',
    }
  }

  return { ok: true, sent }
}
