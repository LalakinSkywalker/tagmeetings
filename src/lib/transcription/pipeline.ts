import 'server-only'

// =============================================================================
// pipeline — pasos compartidos de post-transcripción (Fase 4)
// =============================================================================
// `analizarYCompletar` encapsula traducir → analizar (LLM) → indexar (RAG) →
// completar. Lo usan AMBOS flujos:
//   - single-audio (webhook /api/webhooks/deepgram, 1 callback)
//   - multi-fuente (combine de N fuentes en 1 análisis)
// Así el motor de análisis/indexado NO se duplica (DRY, regla "no parches").
//
// `intentarCombinarFuentes` es la barrera de coordinación: cuando todas las
// fuentes de un padre multi-fuente terminaron (audio transcrito / doc extraído),
// las combina y dispara el análisis UNA sola vez (guarda anti-race vía
// compare-and-swap del estado del padre 'transcribiendo' → 'analizando').
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranscriptionResult } from '@bluntag/transcription-core'
import { getAnalysisEngine, getRagIndex, resolveTemplateAsync } from './index'
import { notificarTranscripcionLista } from '@/lib/notifications/push'
import { maybeTraducir, transcriptionParaAnalisis, TARGET_LANG } from './idioma'
import { combinarFuentes, type FuenteParaCombinar } from './combinar'
import {
  type ModoAnalisis,
  MODO_ANALISIS_DEFAULT,
  normalizarModoAnalisis,
  modoToReasoningEffort,
  modoToModel,
} from './modo-analisis'

export interface AnalizarResult {
  ok: boolean
  message?: string
  chunks?: number
  cost_usd?: number
}

/**
 * Persiste la transcripción (single o combinada), traduce si hace falta, analiza
 * con la plantilla, indexa para Ask y marca completado. Best-effort en traducción
 * e indexado (si fallan, el análisis igual se guarda). Usado por single-audio y
 * multi-fuente.
 *
 * `persistInicial` son las columnas a escribir en transcripciones junto con
 * estado='analizando' (raw_text, segments, duracion_ms, idioma_detectado,
 * transcription_provider, y extras como callback_secret=null o speaker_names).
 */
export async function analizarYCompletar(
  supabase: SupabaseClient,
  transcripcionId: string,
  userId: string,
  templateId: string,
  transcription: TranscriptionResult,
  persistInicial: Record<string, unknown>,
  /**
   * Modo de análisis de la sesión (PRP-TT-V2 Fase 5B-C, Eje 1). Determina el
   * reasoning_effort del LLM en el PRIMER análisis. Default 'rapido' (actual).
   */
  modoAnalisis: ModoAnalisis = MODO_ANALISIS_DEFAULT,
  /**
   * Intención de traducción de la sesión (Fase 7). `null` = no traducir (analizar
   * en el idioma original); código = traducir a ese idioma. Default histórico:
   * español. El webhook/sync lo leen de `transcripciones.traducir_a`.
   */
  traducirA: string | null = TARGET_LANG,
): Promise<AnalizarResult> {
  // ---- 1. Persistir transcripción + estado 'analizando'.
  const { error: persistError } = await supabase
    .from('transcripciones')
    .update({ estado: 'analizando', ...persistInicial })
    .eq('id', transcripcionId)
  if (persistError) {
    throw new Error(`persistir transcripcion fallo: ${persistError.message}`)
  }

  // ---- 2. Traducción según la intención del usuario (best-effort).
  let costTraduccion = 0
  let transcriptionAnalisis = transcription
  try {
    const trad = await maybeTraducir(transcription, traducirA)
    costTraduccion = trad.costUsd || 0
    if (trad.traducido) {
      transcriptionAnalisis = transcriptionParaAnalisis(transcription, trad)
      await supabase
        .from('transcripciones')
        .update({
          traducido_a: trad.traducidoA,
          raw_text_traducido: trad.rawTextTraducido,
          segments_traducido: trad.segmentsTraducido,
        })
        .eq('id', transcripcionId)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] traduccion fallo silenciosamente para ${transcripcionId}: ${message}`)
  }

  // ---- 3. Resolver plantilla.
  const plantilla = await resolveTemplateAsync(supabase, templateId, userId)
  if (!plantilla) {
    await supabase
      .from('transcripciones')
      .update({ estado: 'error', error_message: `Plantilla desconocida: "${templateId}"` })
      .eq('id', transcripcionId)
    return { ok: false, message: 'plantilla desconocida' }
  }

  // ---- 4. Análisis LLM.
  let analisis
  let costAnalisis = 0
  try {
    const engine = getAnalysisEngine()
    // Modo marcador {{sN}}: el primer análisis ya guarda tokens en vez de
    // "Speaker N", así renombrar hablantes después se refleja al instante sin
    // re-analizar (PRP-TT-V2 Fase 5). El render sustituye los tokens.
    analisis = await engine.analyze(transcriptionAnalisis, plantilla, {
      speakerTokens: true,
      reasoningEffort: modoToReasoningEffort(modoAnalisis),
      model: modoToModel(modoAnalisis),
    })
    costAnalisis = analisis.cost_usd || 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('transcripciones')
      .update({ estado: 'error', error_message: `analisis fallo: ${message}`.slice(0, 1000) })
      .eq('id', transcripcionId)
    return { ok: false, message: `analisis fallo: ${message}` }
  }

  // ---- 5. Persistir análisis, estado 'indexando'.
  const { error: persistAnalisisError } = await supabase
    .from('transcripciones')
    .update({
      estado: 'indexando',
      analisis,
      categoria: analisis.categoria,
      cost_usd_total: costTraduccion + costAnalisis,
    })
    .eq('id', transcripcionId)
  if (persistAnalisisError) {
    throw new Error(`persistir analisis fallo: ${persistAnalisisError.message}`)
  }

  // ---- 6. Indexado RAG (best-effort).
  let chunksInserted = 0
  let costIndex = 0
  try {
    const ragIndex = getRagIndex(supabase)
    const indexResult = await ragIndex.index(transcripcionId, transcriptionAnalisis.segments, {
      ownerUserId: userId,
    })
    chunksInserted = indexResult.chunks_inserted
    costIndex = indexResult.cost_usd || 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] index fallo silenciosamente para ${transcripcionId}: ${message}`)
  }

  // ---- 7. Completar.
  const costTotal = costTraduccion + costAnalisis + costIndex
  await supabase
    .from('transcripciones')
    .update({ estado: 'completado', cost_usd_total: costTotal, completed_at: new Date().toISOString() })
    .eq('id', transcripcionId)

  // ---- 8. Avisar al usuario por push (Fase 9). Punto unico de "ya esta lista":
  // ambos flujos (single y multifuente) y el watchdog/reintento pasan por aqui.
  // Best-effort (el helper traga sus errores); nunca rompe el pipeline.
  await notificarTranscripcionLista(transcripcionId, userId)

  return { ok: true, chunks: chunksInserted, cost_usd: costTotal }
}

interface FuenteRow {
  orden: number
  tipo: 'audio' | 'video' | 'pdf' | 'doc' | 'texto'
  nombre_archivo: string | null
  estado: string
  segments: unknown
  texto_extraido: string | null
  duracion_ms: number | null
}

export interface CombinarFuentesResult {
  ok: boolean
  pending?: boolean
  skipped?: boolean
  message?: string
}

/**
 * Barrera de coordinación multi-fuente. Si todas las fuentes del padre
 * terminaron (ninguna en pendiente/subido/transcribiendo), combina las útiles
 * y dispara el análisis UNA vez. La guarda anti-race usa compare-and-swap del
 * estado del padre ('transcribiendo' → 'analizando'): si N callbacks llegan a la
 * vez, solo uno gana el UPDATE condicional y combina; los demás salen (skipped).
 *
 * Acepta cualquier cliente Supabase (service en webhook, user en server action).
 */
export async function intentarCombinarFuentes(
  supabase: SupabaseClient,
  transcripcionId: string,
): Promise<CombinarFuentesResult> {
  // ---- Cargar padre (debe ser multi-fuente y seguir en 'transcribiendo').
  const { data: padre, error: padreErr } = await supabase
    .from('transcripciones')
    .select('id, user_id, template_id, estado, es_multifuente, modo_analisis, traducir_a')
    .eq('id', transcripcionId)
    .single()
  if (padreErr || !padre) return { ok: false, message: 'padre no encontrado' }
  if (!padre.es_multifuente) return { ok: false, message: 'no es multifuente' }
  if (padre.estado !== 'transcribiendo') {
    // Ya está siendo combinado/analizado/completado por otro callback.
    return { ok: true, skipped: true }
  }

  // ---- Cargar fuentes; si alguna sigue en proceso, esperar.
  const { data: fuentes, error: fuentesErr } = await supabase
    .from('transcripcion_fuentes')
    .select('orden, tipo, nombre_archivo, estado, segments, texto_extraido, duracion_ms')
    .eq('transcripcion_id', transcripcionId)
    .order('orden', { ascending: true })
  if (fuentesErr || !fuentes || fuentes.length === 0) {
    return { ok: false, message: 'sin fuentes' }
  }

  const pendientes = (fuentes as FuenteRow[]).filter((f) =>
    f.estado === 'pendiente' || f.estado === 'subido' || f.estado === 'transcribiendo',
  )
  if (pendientes.length > 0) return { ok: true, pending: true }

  // ---- Compare-and-swap: solo un caller gana el paso a 'analizando'.
  const { data: claim } = await supabase
    .from('transcripciones')
    .update({ estado: 'analizando' })
    .eq('id', transcripcionId)
    .eq('estado', 'transcribiendo')
    .select('id')
  if (!claim || claim.length === 0) {
    // Otro callback ya tomó la combinación.
    return { ok: true, skipped: true }
  }

  // ---- Combinar fuentes útiles (transcrito). Las 'error' se ignoran.
  const utiles = (fuentes as FuenteRow[])
    .filter((f) => f.estado === 'transcrito')
    .map<FuenteParaCombinar>((f) => ({
      orden: f.orden,
      tipo: f.tipo,
      nombre: f.nombre_archivo ?? `Fuente ${f.orden + 1}`,
      segments: f.segments,
      texto_extraido: f.texto_extraido,
      duracion_ms: f.duracion_ms,
    }))

  const { transcription, speakerNames } = combinarFuentes(utiles)

  if (transcription.segments.length === 0) {
    await supabase
      .from('transcripciones')
      .update({
        estado: 'error',
        error_message: 'Ninguna fuente produjo contenido analizable.',
      })
      .eq('id', transcripcionId)
    return { ok: false, message: 'sin contenido combinable' }
  }

  // ---- Analizar y completar sobre el resultado combinado.
  const res = await analizarYCompletar(
    supabase,
    transcripcionId,
    padre.user_id as string,
    padre.template_id as string,
    transcription,
    {
      raw_text: transcription.raw_text,
      segments: transcription.segments,
      duracion_ms: transcription.duration_ms,
      idioma_detectado: null,
      transcription_provider: 'multifuente',
      speaker_names: speakerNames,
    },
    normalizarModoAnalisis((padre as { modo_analisis?: unknown }).modo_analisis),
    // null = el usuario eligio "no traducir" (se respeta). El draft siempre setea
    // un valor concreto, asi que aqui nunca es undefined.
    (padre as { traducir_a?: string | null }).traducir_a ?? null,
  )
  return { ok: res.ok, message: res.message }
}
