import 'server-only'

// =============================================================================
// watchdog — barrido de jobs async atorados
// =============================================================================
// El flujo async (Deepgram callback) puede dejar jobs huérfanos: un callback que
// nunca llega (audio grande), o trabajo en `after()` que excede el presupuesto
// serverless de 300s. Sin esto, un job queda colgado en un estado intermedio
// PARA SIEMPRE (le pasó al discovery de Daniel TMG, 42h). El watchdog corre
// periódicamente (cron) y cierra el círculo: detecta atorados por `updated_at`
// viejo en un estado intermedio y los re-encamina (reintento con tope) o los
// cierra en `error` con mensaje claro.
//
// Cuatro barridos (cubren TODAS las clases de huérfano):
//   1. Fuente de audio atorada (pendiente/subido/transcribiendo) → re-lanzar Deepgram (tope) o error.
//   2. Padre multi-fuente atorado en 'transcribiendo' → re-intentar la barrera de combinación.
//   3. Padre (single o multi) atorado en 'analizando'/'indexando' → re-disparar análisis (tope) o error.
//   4. Padre SINGLE atorado en 'transcribiendo'/'pendiente' → re-lanzar Deepgram (tope) o error.
//
// SEGURIDAD/CONCURRENCIA: cada acción reclama la fila con compare-and-swap
// (`.eq('estado', actual).lt('updated_at', cutoff)`): si dos watchdogs corren a
// la vez, o uno se solapa con un callback que sí llegó, solo uno gana el UPDATE
// (que además refresca `updated_at` vía trigger, sacando la fila del cutoff). Así
// nunca se duplica análisis ni se pisa un job que ya avanzó.
//
// Corre con cliente service-role (bypassa RLS) — SOLO desde el cron protegido.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranscriptionResult } from '@bluntag/transcription-core'
import { lanzarFuenteDeepgram, lanzarSingleDeepgram } from './relanzar'
import { analizarYCompletar, intentarCombinarFuentes } from './pipeline'
import { normalizarModoAnalisis } from './modo-analisis'

/** Umbral para considerar "atorado" un estado de transcripción (Deepgram puede
 *  tardar 5-15 min legítimamente en audios largos → margen amplio). */
export const UMBRAL_TRANSCRIBIENDO_MS = 20 * 60_000 // 20 min
/** Umbral para 'analizando'/'indexando' (el LLM + indexado normal toma <5 min). */
export const UMBRAL_ANALISIS_MS = 10 * 60_000 // 10 min
/** Reintentos automáticos antes de rendirse (= N re-lanzamientos; el lanzamiento
 *  inicial NO cuenta). Tras agotarlos, la fila queda en `error`. */
export const TOPE_INTENTOS = 2
/** Paths que NUNCA corresponden a un objeto real en R2 (no re-transcribibles). */
const PATHS_NO_REALES = new Set(['placeholder', 'multifuente'])

export interface WatchdogAccion {
  tipo: 'fuente' | 'padre_combina' | 'padre_analisis' | 'padre_single'
  id: string
  accion: 'relanzado' | 'reintento_combina' | 'error_tope' | 'error_relanzar' | 'error_sin_audio'
  detalle?: string
}

export interface WatchdogResult {
  revisados: number
  acciones: WatchdogAccion[]
}

function transcriptionDesdeFila(p: {
  segments: unknown
  idioma: string | null
  idioma_detectado: string | null
  duracion_ms: number | null
  raw_text: string | null
  transcription_provider: string | null
}): TranscriptionResult {
  return {
    segments: (p.segments ?? []) as TranscriptionResult['segments'],
    language: p.idioma ?? 'es-MX',
    detected_language: p.idioma_detectado ?? undefined,
    duration_ms: p.duracion_ms ?? 0,
    raw_text: p.raw_text ?? '',
    provider: (p.transcription_provider as TranscriptionResult['provider']) ?? 'deepgram-nova-3',
  }
}

/**
 * Ejecuta un barrido completo de jobs atorados. Idempotente y seguro ante
 * concurrencia. Devuelve un resumen de lo que tocó (para logging del cron).
 */
export async function correrWatchdog(supabase: SupabaseClient): Promise<WatchdogResult> {
  const acciones: WatchdogAccion[] = []
  let revisados = 0
  const ahora = Date.now()
  const cutoffTranscribiendo = new Date(ahora - UMBRAL_TRANSCRIBIENDO_MS).toISOString()
  const cutoffAnalisis = new Date(ahora - UMBRAL_ANALISIS_MS).toISOString()

  // ===========================================================================
  // BARRIDO 1 — Fuentes de audio atoradas (multi-fuente).
  // ===========================================================================
  const { data: fuentes } = await supabase
    .from('transcripcion_fuentes')
    .select('id, transcripcion_id, estado, audio_path, intentos, tipo')
    .in('estado', ['pendiente', 'subido', 'transcribiendo'])
    .in('tipo', ['audio', 'video'])
    .lt('updated_at', cutoffTranscribiendo)
    .limit(50)

  // idioma del padre por transcripcion_id (para re-lanzar la fuente).
  const padreIds = Array.from(new Set((fuentes ?? []).map((f) => f.transcripcion_id as string)))
  const idiomaPorPadre = new Map<string, string>()
  if (padreIds.length > 0) {
    const { data: padres } = await supabase
      .from('transcripciones')
      .select('id, idioma')
      .in('id', padreIds)
    for (const p of padres ?? []) {
      idiomaPorPadre.set(p.id as string, (p.idioma as string) ?? 'es-MX')
    }
  }

  for (const f of fuentes ?? []) {
    revisados++
    const fuenteId = f.id as string
    const transcripcionId = f.transcripcion_id as string
    const audioPath = (f.audio_path as string) ?? ''
    const estadoActual = f.estado as string
    const intentos = (f.intentos as number) ?? 0

    // Sin audio real → no re-transcribible: error (CAS).
    if (!audioPath || PATHS_NO_REALES.has(audioPath)) {
      const { data: claim } = await supabase
        .from('transcripcion_fuentes')
        .update({ estado: 'error', error_message: 'Audio no disponible para reintentar.', callback_secret: null })
        .eq('id', fuenteId).eq('estado', estadoActual).lt('updated_at', cutoffTranscribiendo)
        .select('id')
      if (claim && claim.length > 0) {
        acciones.push({ tipo: 'fuente', id: fuenteId, accion: 'error_sin_audio' })
        await intentarCombinarFuentes(supabase, transcripcionId)
      }
      continue
    }

    // Tope agotado → error (CAS) + intentar combinar lo útil.
    if (intentos >= TOPE_INTENTOS) {
      const { data: claim } = await supabase
        .from('transcripcion_fuentes')
        .update({ estado: 'error', error_message: `Transcripción falló tras ${intentos} reintentos.`, callback_secret: null })
        .eq('id', fuenteId).eq('estado', estadoActual).lt('updated_at', cutoffTranscribiendo)
        .select('id')
      if (claim && claim.length > 0) {
        acciones.push({ tipo: 'fuente', id: fuenteId, accion: 'error_tope' })
        await intentarCombinarFuentes(supabase, transcripcionId)
      }
      continue
    }

    // Reclamar (CAS) antes de re-lanzar: solo uno gana; el UPDATE refresca
    // updated_at (trigger) sacando la fila del cutoff para otros watchdogs.
    const { data: claim } = await supabase
      .from('transcripcion_fuentes')
      .update({ estado: 'transcribiendo' })
      .eq('id', fuenteId).eq('estado', estadoActual).lt('updated_at', cutoffTranscribiendo)
      .select('id')
    if (!claim || claim.length === 0) continue // otro lo tomó

    try {
      await lanzarFuenteDeepgram(supabase, {
        transcripcionId,
        fuenteId,
        audioPath,
        idioma: idiomaPorPadre.get(transcripcionId) ?? 'es-MX',
        nuevoIntentos: intentos + 1,
      })
      acciones.push({ tipo: 'fuente', id: fuenteId, accion: 'relanzado', detalle: `intento ${intentos + 1}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await supabase
        .from('transcripcion_fuentes')
        .update({ estado: 'error', error_message: `Reintento falló: ${msg}`.slice(0, 500), callback_secret: null })
        .eq('id', fuenteId)
      acciones.push({ tipo: 'fuente', id: fuenteId, accion: 'error_relanzar', detalle: msg.slice(0, 120) })
      await intentarCombinarFuentes(supabase, transcripcionId)
    }
  }

  // ===========================================================================
  // BARRIDO 2 — Padres multi-fuente atorados en 'transcribiendo': re-intentar
  // la barrera (cubre el caso en que el combine en after() del último callback
  // se mató). intentarCombinarFuentes es idempotente: si aún hay fuentes en
  // proceso devuelve pending sin hacer daño.
  // ===========================================================================
  const { data: padresTransc } = await supabase
    .from('transcripciones')
    .select('id')
    .eq('es_multifuente', true)
    .eq('estado', 'transcribiendo')
    .lt('updated_at', cutoffTranscribiendo)
    .limit(50)
  for (const p of padresTransc ?? []) {
    revisados++
    const res = await intentarCombinarFuentes(supabase, p.id as string)
    if (!res.pending && !res.skipped) {
      acciones.push({ tipo: 'padre_combina', id: p.id as string, accion: 'reintento_combina' })
    }
  }

  // ===========================================================================
  // BARRIDO 3 — Padres (single o multi) atorados en 'analizando'/'indexando':
  // re-disparar el análisis (idempotente desde el persist inicial) con tope.
  // ===========================================================================
  const { data: padresAnalisis } = await supabase
    .from('transcripciones')
    .select('id, estado, raw_text, segments, duracion_ms, idioma, idioma_detectado, template_id, user_id, modo_analisis, traducir_a, transcription_provider, speaker_names, intentos')
    .in('estado', ['analizando', 'indexando'])
    .lt('updated_at', cutoffAnalisis)
    .limit(50)
  for (const p of padresAnalisis ?? []) {
    revisados++
    const id = p.id as string
    const estadoActual = p.estado as string
    const intentos = (p.intentos as number) ?? 0
    const tieneTexto = typeof p.raw_text === 'string' && p.raw_text.length > 0 && Array.isArray(p.segments)

    // Sin transcripción que analizar, o tope agotado → error (CAS).
    if (!tieneTexto || intentos >= TOPE_INTENTOS) {
      const msg = !tieneTexto
        ? 'Análisis sin transcripción base (texto vacío).'
        : `Análisis falló tras ${intentos} reintentos.`
      const { data: claim } = await supabase
        .from('transcripciones')
        .update({ estado: 'error', error_message: msg })
        .eq('id', id).eq('estado', estadoActual).lt('updated_at', cutoffAnalisis)
        .select('id')
      if (claim && claim.length > 0) {
        acciones.push({ tipo: 'padre_analisis', id, accion: 'error_tope', detalle: msg })
      }
      continue
    }

    // Reclamar (CAS) → 'analizando' + intentos+1.
    const { data: claim } = await supabase
      .from('transcripciones')
      .update({ estado: 'analizando', intentos: intentos + 1 })
      .eq('id', id).eq('estado', estadoActual).lt('updated_at', cutoffAnalisis)
      .select('id')
    if (!claim || claim.length === 0) continue

    try {
      const transcription = transcriptionDesdeFila(p)
      await analizarYCompletar(
        supabase,
        id,
        p.user_id as string,
        p.template_id as string,
        transcription,
        {
          raw_text: transcription.raw_text,
          segments: transcription.segments,
          duracion_ms: transcription.duration_ms,
          idioma_detectado: transcription.detected_language ?? null,
          transcription_provider: transcription.provider,
          speaker_names: p.speaker_names ?? {},
        },
        normalizarModoAnalisis((p as { modo_analisis?: unknown }).modo_analisis),
        (p as { traducir_a?: string | null }).traducir_a ?? null,
      )
      acciones.push({ tipo: 'padre_analisis', id, accion: 'relanzado', detalle: `intento ${intentos + 1}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await supabase
        .from('transcripciones')
        .update({ estado: 'error', error_message: `Re-análisis falló: ${msg}`.slice(0, 1000) })
        .eq('id', id)
      acciones.push({ tipo: 'padre_analisis', id, accion: 'error_relanzar', detalle: msg.slice(0, 120) })
    }
  }

  // ===========================================================================
  // BARRIDO 4 — Padres SINGLE atorados en 'transcribiendo'/'pendiente':
  // re-lanzar Deepgram (tope) o error. (Los multi-fuente NO entran aquí: su
  // 'transcribiendo' lo gobiernan las fuentes, barridos 1 y 2.)
  // ===========================================================================
  const { data: singles } = await supabase
    .from('transcripciones')
    .select('id, estado, audio_path, idioma, intentos')
    .eq('es_multifuente', false)
    .in('estado', ['pendiente', 'transcribiendo'])
    .lt('updated_at', cutoffTranscribiendo)
    .limit(50)
  for (const p of singles ?? []) {
    revisados++
    const id = p.id as string
    const estadoActual = p.estado as string
    const audioPath = (p.audio_path as string) ?? ''
    const intentos = (p.intentos as number) ?? 0

    if (!audioPath || PATHS_NO_REALES.has(audioPath)) {
      const { data: claim } = await supabase
        .from('transcripciones')
        .update({ estado: 'error', error_message: 'Audio no disponible para reintentar.', callback_secret: null })
        .eq('id', id).eq('estado', estadoActual).lt('updated_at', cutoffTranscribiendo)
        .select('id')
      if (claim && claim.length > 0) acciones.push({ tipo: 'padre_single', id, accion: 'error_sin_audio' })
      continue
    }
    if (intentos >= TOPE_INTENTOS) {
      const { data: claim } = await supabase
        .from('transcripciones')
        .update({ estado: 'error', error_message: `Transcripción falló tras ${intentos} reintentos.`, callback_secret: null })
        .eq('id', id).eq('estado', estadoActual).lt('updated_at', cutoffTranscribiendo)
        .select('id')
      if (claim && claim.length > 0) acciones.push({ tipo: 'padre_single', id, accion: 'error_tope' })
      continue
    }

    const { data: claim } = await supabase
      .from('transcripciones')
      .update({ estado: 'transcribiendo' })
      .eq('id', id).eq('estado', estadoActual).lt('updated_at', cutoffTranscribiendo)
      .select('id')
    if (!claim || claim.length === 0) continue

    try {
      await lanzarSingleDeepgram(supabase, {
        transcripcionId: id,
        audioPath,
        idioma: (p.idioma as string) ?? 'es-MX',
        nuevoIntentos: intentos + 1,
      })
      acciones.push({ tipo: 'padre_single', id, accion: 'relanzado', detalle: `intento ${intentos + 1}` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await supabase
        .from('transcripciones')
        .update({ estado: 'error', error_message: `Reintento falló: ${msg}`.slice(0, 1000), callback_secret: null })
        .eq('id', id)
      acciones.push({ tipo: 'padre_single', id, accion: 'error_relanzar', detalle: msg.slice(0, 120) })
    }
  }

  return { revisados, acciones }
}
