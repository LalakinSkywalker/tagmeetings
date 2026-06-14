import 'server-only'

// =============================================================================
// relanzar — lanzar/re-lanzar la transcripción async de UNA fuente
// =============================================================================
// Factoriza el bloque que antes vivía inline en `iniciarTranscripcionMultifuente`
// para que tengan UNA sola fuente de verdad (DRY, regla "no parches"):
//   - el primer lanzamiento (server action multifuente),
//   - el WATCHDOG (cron) que re-lanza fuentes huérfanas,
//   - el reintento manual desde la UI.
//
// Acepta cualquier cliente Supabase: user-authed (server action, RLS aplica) o
// service-role (webhook/cron, bypassa RLS). NO decide política de reintento ni
// topes — eso vive en el caller (watchdog). Aquí solo: marcar 'transcribiendo'
// con secret fresco, firmar la URL de R2, disparar Deepgram async y persistir el
// request_id. Lanza si Deepgram/R2 fallan; el caller marca la fuente 'error'.
// =============================================================================

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStorageAdapter, getTranscriptionProvider } from './index'
import { buildDeepgramCallbackUrl } from './callback-url'
import type { AsyncTranscriptionProvider } from '@bluntag/transcription-core'

/** TTL de la URL firmada de descarga (6h): margen para que Deepgram baje audios
 *  largos antes de que caduque. Igual criterio que el flujo original. */
const DOWNLOAD_TTL_SEC = 21_600

export interface LanzarFuenteParams {
  transcripcionId: string
  fuenteId: string
  audioPath: string
  idioma: string
  /**
   * Si se pasa, escribe este valor en `intentos` en el mismo UPDATE (lo calcula
   * el caller: típicamente `intentos_actuales + 1` en un reintento). Omitir en el
   * primer lanzamiento (la columna queda en su default 0).
   */
  nuevoIntentos?: number
}

/**
 * Lanza (o re-lanza) la transcripción async de una fuente de audio/video en
 * Deepgram. Marca la fuente `transcribiendo` con un secret fresco (el trigger
 * `updated_at` refresca el reloj del watchdog), genera la URL firmada de R2,
 * construye el callback y dispara el job; persiste el `request_id`.
 *
 * @returns `{ requestId }` del job lanzado.
 * @throws si el provider no soporta async, o si R2/Deepgram/persistencia fallan.
 */
export async function lanzarFuenteDeepgram(
  supabase: SupabaseClient,
  { transcripcionId, fuenteId, audioPath, idioma, nuevoIntentos }: LanzarFuenteParams,
): Promise<{ requestId: string }> {
  const provider = getTranscriptionProvider() as AsyncTranscriptionProvider
  if (typeof provider.transcribeAsync !== 'function') {
    throw new Error(
      'lanzarFuenteDeepgram: el provider configurado no soporta modo async (transcribeAsync ausente).',
    )
  }
  const storage = getStorageAdapter()
  const secret = randomUUID()

  // Marca 'transcribiendo' + secret fresco ANTES de disparar Deepgram (si el
  // callback llegara rapidísimo, la BD ya tiene el secret). El trigger de
  // updated_at refresca la última actividad → el watchdog parte el reloj de cero.
  const update: Record<string, unknown> = { estado: 'transcribiendo', callback_secret: secret }
  if (typeof nuevoIntentos === 'number') update.intentos = nuevoIntentos
  const { error: updErr } = await supabase
    .from('transcripcion_fuentes')
    .update(update)
    .eq('id', fuenteId)
  if (updErr) {
    throw new Error(`lanzarFuenteDeepgram: marcar 'transcribiendo' fallo: ${updErr.message}`)
  }

  const audioUrl = await storage.getSignedDownloadUrl(audioPath, { expiresInSec: DOWNLOAD_TTL_SEC })
  const callbackUrl = await buildDeepgramCallbackUrl(transcripcionId, secret, fuenteId)
  const ack = await provider.transcribeAsync(audioUrl, {
    language: idioma,
    diarize: true,
    punctuate: true,
    callbackUrl,
  })

  const { error: reqErr } = await supabase
    .from('transcripcion_fuentes')
    .update({ request_id: ack.request_id })
    .eq('id', fuenteId)
  if (reqErr) {
    throw new Error(`lanzarFuenteDeepgram: persistir request_id fallo: ${reqErr.message}`)
  }

  return { requestId: ack.request_id }
}

export interface LanzarSingleParams {
  transcripcionId: string
  audioPath: string
  idioma: string
  /** Igual que en `lanzarFuenteDeepgram`: si se pasa, escribe `intentos` (reintento). */
  nuevoIntentos?: number
}

/**
 * Lanza (o re-lanza) la transcripción async de una transcripción SINGLE-AUDIO
 * (no multi-fuente). Marca el padre `transcribiendo` con secret fresco (el secret
 * vive en `transcripciones.callback_secret`; el callback NO lleva `&fuente=`),
 * firma la URL R2 y dispara Deepgram. `transcripciones` no tiene columna
 * `request_id`, así que no se persiste (igual que el flujo original que solo lo
 * logueaba). Usado por el watchdog para re-lanzar un single huérfano.
 *
 * @throws si el provider no soporta async o si R2/Deepgram fallan.
 */
export async function lanzarSingleDeepgram(
  supabase: SupabaseClient,
  { transcripcionId, audioPath, idioma, nuevoIntentos }: LanzarSingleParams,
): Promise<{ requestId: string }> {
  const provider = getTranscriptionProvider() as AsyncTranscriptionProvider
  if (typeof provider.transcribeAsync !== 'function') {
    throw new Error(
      'lanzarSingleDeepgram: el provider configurado no soporta modo async (transcribeAsync ausente).',
    )
  }
  const storage = getStorageAdapter()
  const secret = randomUUID()

  const update: Record<string, unknown> = { estado: 'transcribiendo', callback_secret: secret }
  if (typeof nuevoIntentos === 'number') update.intentos = nuevoIntentos
  const { error: updErr } = await supabase
    .from('transcripciones')
    .update(update)
    .eq('id', transcripcionId)
  if (updErr) {
    throw new Error(`lanzarSingleDeepgram: marcar 'transcribiendo' fallo: ${updErr.message}`)
  }

  const audioUrl = await storage.getSignedDownloadUrl(audioPath, { expiresInSec: DOWNLOAD_TTL_SEC })
  const callbackUrl = await buildDeepgramCallbackUrl(transcripcionId, secret)
  const ack = await provider.transcribeAsync(audioUrl, {
    language: idioma,
    diarize: true,
    punctuate: true,
    callbackUrl,
  })
  return { requestId: ack.request_id }
}
