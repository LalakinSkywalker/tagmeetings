'use server'

// =============================================================================
// Server action — Reintentar una transcripción atorada/fallida
// =============================================================================
// El equivalente MANUAL del watchdog, para UN job, disparado por el usuario
// desde la UI (botón "Reintentar"). A diferencia del watchdog (service-role +
// umbral de tiempo), corre con el cliente del usuario (RLS) y SIN umbral: el
// usuario decide reintentar ya. Reusa los MISMOS motores (lanzar* + pipeline),
// así que no duplica lógica (DRY).
//
// Decisión inteligente del paso a re-lanzar:
//   - Si la transcripción YA tiene texto (raw_text + segments) → el fallo fue en
//     análisis/indexado → re-corre `analizarYCompletar` (sin Deepgram).
//   - Si NO tiene texto → la transcripción quedó incompleta → re-lanza Deepgram
//     (multi-fuente: las fuentes que falten; single: el audio).
//
// Resetea `intentos = 0`: un reintento manual da presupuesto fresco al watchdog.
// =============================================================================

import { revalidatePath } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranscriptionResult } from '@bluntag/transcription-core'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { lanzarFuenteDeepgram, lanzarSingleDeepgram } from '@/lib/transcription/relanzar'
import { analizarYCompletar, intentarCombinarFuentes } from '@/lib/transcription/pipeline'
import { normalizarModoAnalisis } from '@/lib/transcription/modo-analisis'

const PATHS_NO_REALES = new Set(['placeholder', 'multifuente'])

export interface ReintentarResult {
  ok: boolean
  /** Estado tras el reintento (para que la UI refresque/poll). */
  estado?: string
  /** Mensaje legible para el usuario. */
  mensaje?: string
  errorMessage?: string
}

interface FilaParaReintento {
  id: string
  estado: string
  es_multifuente: boolean
  audio_path: string | null
  idioma: string | null
  raw_text: string | null
  segments: unknown
  duracion_ms: number | null
  idioma_detectado: string | null
  template_id: string
  modo_analisis: string | null
  traducir_a: string | null
  transcription_provider: string | null
  speaker_names: unknown
}

function tieneTranscripcion(t: FilaParaReintento): boolean {
  return (
    typeof t.raw_text === 'string' &&
    t.raw_text.length > 0 &&
    Array.isArray(t.segments) &&
    t.segments.length > 0
  )
}

function transcriptionDesdeFila(t: FilaParaReintento): TranscriptionResult {
  return {
    segments: (t.segments ?? []) as TranscriptionResult['segments'],
    language: t.idioma ?? 'es-MX',
    detected_language: t.idioma_detectado ?? undefined,
    duration_ms: t.duracion_ms ?? 0,
    raw_text: t.raw_text ?? '',
    provider: (t.transcription_provider as TranscriptionResult['provider']) ?? 'deepgram-nova-3',
  }
}

/** Re-corre el análisis sobre una transcripción que ya tiene texto. */
async function reAnalizar(
  supabase: SupabaseClient,
  userId: string,
  t: FilaParaReintento,
): Promise<ReintentarResult> {
  await supabase
    .from('transcripciones')
    .update({ estado: 'analizando', intentos: 0, error_message: null })
    .eq('id', t.id)

  const transcription = transcriptionDesdeFila(t)
  const res = await analizarYCompletar(
    supabase,
    t.id,
    userId,
    t.template_id,
    transcription,
    {
      raw_text: transcription.raw_text,
      segments: transcription.segments,
      duracion_ms: transcription.duration_ms,
      idioma_detectado: transcription.detected_language ?? null,
      transcription_provider: transcription.provider,
      speaker_names: t.speaker_names ?? {},
    },
    normalizarModoAnalisis(t.modo_analisis),
    t.traducir_a ?? null,
  )
  return res.ok
    ? { ok: true, estado: 'completado', mensaje: 'Re-análisis completado.' }
    : { ok: false, errorMessage: res.message ?? 'El re-análisis falló.' }
}

/** Re-lanza la transcripción de las fuentes que falten en un multi-fuente. */
async function reintentarMultifuente(
  supabase: SupabaseClient,
  t: FilaParaReintento,
): Promise<ReintentarResult> {
  const { data: fuentes } = await supabase
    .from('transcripcion_fuentes')
    .select('id, estado, audio_path, tipo')
    .eq('transcripcion_id', t.id)
    .order('orden', { ascending: true })

  // Reset del padre a 'transcribiendo' (presupuesto fresco).
  await supabase
    .from('transcripciones')
    .update({ estado: 'transcribiendo', intentos: 0, error_message: null })
    .eq('id', t.id)

  const idioma = t.idioma ?? 'es-MX'
  let relanzadas = 0
  for (const f of fuentes ?? []) {
    if (f.estado === 'transcrito') continue // ya está, no se re-toca
    const tipo = f.tipo as string
    const audioPath = (f.audio_path as string) ?? ''
    if (tipo !== 'audio' && tipo !== 'video') continue // docs: no re-extraemos aquí
    if (!audioPath || PATHS_NO_REALES.has(audioPath)) {
      await supabase
        .from('transcripcion_fuentes')
        .update({ estado: 'error', error_message: 'Audio no disponible para reintentar.', callback_secret: null })
        .eq('id', f.id)
      continue
    }
    await lanzarFuenteDeepgram(supabase, {
      transcripcionId: t.id,
      fuenteId: f.id as string,
      audioPath,
      idioma,
      nuevoIntentos: 0,
    })
    relanzadas++
  }

  // Si no quedó nada por re-lanzar (todas transcrito), intenta combinar ya.
  if (relanzadas === 0) {
    await intentarCombinarFuentes(supabase, t.id)
  }
  return {
    ok: true,
    estado: 'transcribiendo',
    mensaje: relanzadas > 0
      ? `Reintento lanzado (${relanzadas} archivo${relanzadas > 1 ? 's' : ''}).`
      : 'Reprocesando el análisis combinado.',
  }
}

/** Re-lanza la transcripción de un single-audio. */
async function reintentarSingle(
  supabase: SupabaseClient,
  t: FilaParaReintento,
): Promise<ReintentarResult> {
  const audioPath = t.audio_path ?? ''
  if (!audioPath || PATHS_NO_REALES.has(audioPath)) {
    await supabase
      .from('transcripciones')
      .update({ estado: 'error', error_message: 'Audio no disponible para reintentar.', callback_secret: null })
      .eq('id', t.id)
    return { ok: false, errorMessage: 'El audio ya no está disponible para reintentar.' }
  }
  await lanzarSingleDeepgram(supabase, {
    transcripcionId: t.id,
    audioPath,
    idioma: t.idioma ?? 'es-MX',
    nuevoIntentos: 0,
  })
  return { ok: true, estado: 'transcribiendo', mensaje: 'Reintento de transcripción lanzado.' }
}

/**
 * Reintenta manualmente una transcripción atorada o en error. Decide solo el
 * paso a re-lanzar (análisis vs transcripción) según si ya hay texto. Devuelve
 * un resultado legible para la UI. Idempotente respecto a 'completado'.
 */
export async function reintentarTranscripcion(
  transcripcionId: string,
): Promise<ReintentarResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, errorMessage: 'Identificador inválido.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, errorMessage: 'No autenticado.' }

  const { data, error } = await supabase
    .from('transcripciones')
    .select(
      'id, estado, es_multifuente, audio_path, idioma, raw_text, segments, duracion_ms, idioma_detectado, template_id, modo_analisis, traducir_a, transcription_provider, speaker_names',
    )
    .eq('id', transcripcionId)
    .single()
  if (error || !data) {
    return { ok: false, errorMessage: 'Transcripción no encontrada o sin permisos.' }
  }

  const t = data as FilaParaReintento
  if (t.estado === 'completado') {
    return { ok: true, estado: 'completado', mensaje: 'La transcripción ya está completada.' }
  }

  try {
    let res: ReintentarResult
    if (tieneTranscripcion(t)) {
      // Ya hay texto: el fallo fue en análisis/indexado → re-analizar (sin Deepgram).
      res = await reAnalizar(supabase, user.id, t)
    } else if (t.es_multifuente) {
      res = await reintentarMultifuente(supabase, t)
    } else {
      res = await reintentarSingle(supabase, t)
    }
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Best-effort: deja la fila en 'error' con causa clara si el reintento explotó.
    await supabase
      .from('transcripciones')
      .update({ estado: 'error', error_message: `Reintento falló: ${msg}`.slice(0, 1000) })
      .eq('id', transcripcionId)
    return { ok: false, errorMessage: msg }
  } finally {
    revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)
    revalidatePath('/dashboard')
  }
}
