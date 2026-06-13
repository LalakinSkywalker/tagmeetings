// =============================================================================
// Helpers de idioma + traduccion (PRP-TT-V2 Fase 2)
// =============================================================================
// Centraliza la logica de: (1) decidir si una transcripcion necesita traduccion
// al espanol, (2) ejecutar la traduccion via el LLMTranslator, y (3) contar
// hablantes detectados para la alerta de discrepancia. Lo usan tanto el webhook
// async (service client) como el path sync de iniciarTranscripcion.
// =============================================================================

import 'server-only'
import type { TranscriptionResult, TranscriptSegment } from '@bluntag/transcription-core'
import { getTranslator } from './index'
import { idiomaLabel } from './idiomas'

/** Idioma destino por defecto historico (espanol). Fase 7 lo hace configurable. */
export const TARGET_LANG = 'es-MX'

/** True si el codigo BCP-47 corresponde a espanol (es, es-MX, es-419, ...). */
export function isSpanish(lang?: string | null): boolean {
  if (!lang) return false
  const lower = lang.toLowerCase()
  return lower === 'multi' ? false : lower.startsWith('es')
}

/**
 * True si dos codigos comparten idioma base (es-MX ~ es-419, en ~ en-US). Sirve
 * para no traducir cuando el audio ya esta en el idioma destino. `multi`/vacio
 * nunca matchean (forzamos el intento de traduccion como antes).
 */
function mismoIdioma(a: string, b: string): boolean {
  const pa = a.toLowerCase().split('-')[0]
  const pb = b.toLowerCase().split('-')[0]
  return pa.length > 0 && pa !== 'multi' && pa === pb
}

/** Descripcion del idioma destino para el prompt del traductor LLM. */
function nombreIdiomaParaTraduccion(codigo: string): string {
  if (isSpanish(codigo)) return 'español de México'
  return idiomaLabel(codigo)
}

/**
 * Idioma "efectivo" de una transcripcion: el detectado si existe, si no el
 * solicitado. Es el que decide si hace falta traducir.
 */
export function idiomaEfectivo(t: TranscriptionResult): string {
  return t.detected_language ?? t.language ?? ''
}

/** Cuenta hablantes distintos presentes en los segments. */
export function contarSpeakers(
  segments: ReadonlyArray<{ speaker?: { id?: number | null } }>,
): number {
  const set = new Set<number>()
  for (const s of segments) {
    const id = s?.speaker?.id
    if (typeof id === 'number' && Number.isFinite(id)) set.add(id)
  }
  return set.size
}

export interface TraduccionResult {
  /** true si se genero una traduccion (el audio no estaba en espanol). */
  traducido: boolean
  /** Idioma detectado/efectivo (para persistir en idioma_detectado). */
  idiomaDetectado: string | null
  /** Idioma destino aplicado, o null si no se tradujo. */
  traducidoA: string | null
  /** Texto plano traducido, o null. */
  rawTextTraducido: string | null
  /** Segments traducidos, o null. */
  segmentsTraducido: TranscriptSegment[] | null
  /** Costo USD del paso de traduccion (0 si no hubo). */
  costUsd: number
}

/**
 * Decide y ejecuta la traduccion segun la INTENCION configurada por el usuario
 * (Fase 7). `traducirA`:
 *   - `null`  → NO traducir: analizar/indexar en el idioma original.
 *   - codigo  → traducir a ese idioma SI el audio no esta ya en el (ej 'es-MX',
 *               'en'). Si el audio ya esta en el idioma destino, no-op.
 * Degrada con gracia: si no hay traductor (sin key / mock) o no hay texto, no
 * traduce y el flujo continua con el original. NUNCA lanza — un fallo de
 * traduccion no debe tumbar la transcripcion.
 */
export async function maybeTraducir(
  transcription: TranscriptionResult,
  traducirA: string | null,
): Promise<TraduccionResult> {
  const idiomaDetectado = transcription.detected_language ?? null

  const base: TraduccionResult = {
    traducido: false,
    idiomaDetectado,
    traducidoA: null,
    rawTextTraducido: null,
    segmentsTraducido: null,
    costUsd: 0,
  }

  // Config del usuario: no traducir.
  if (!traducirA) return base
  // Sin texto → nada que traducir.
  if (!transcription.segments || transcription.segments.length === 0) return base
  // El audio ya esta en el idioma destino → no traducir.
  if (mismoIdioma(idiomaEfectivo(transcription), traducirA)) return base

  const translator = getTranslator()
  if (!translator) return base // sin key / mock: degradar con gracia

  try {
    const result = await translator.translateSegments(
      transcription.segments,
      nombreIdiomaParaTraduccion(traducirA),
    )
    return {
      traducido: true,
      idiomaDetectado,
      traducidoA: traducirA,
      rawTextTraducido: result.raw_text,
      segmentsTraducido: result.segments,
      costUsd: result.cost_usd,
    }
  } catch {
    // Falla de traduccion: continuar con el original, no tumbar la transcripcion.
    return base
  }
}

/**
 * Wrapper retrocompatible: traduce al espanol (comportamiento historico).
 * Equivale a `maybeTraducir(t, TARGET_LANG)`.
 */
export async function maybeTraducirAEspanol(
  transcription: TranscriptionResult,
): Promise<TraduccionResult> {
  return maybeTraducir(transcription, TARGET_LANG)
}

/**
 * Construye la TranscriptionResult que debe ir al ANALISIS y al INDEXADO RAG:
 * la version traducida al espanol cuando existe, si no la original. Asi el
 * resumen sale siempre en espanol y el Ask responde en espanol.
 */
export function transcriptionParaAnalisis(
  original: TranscriptionResult,
  trad: TraduccionResult,
): TranscriptionResult {
  if (trad.traducido && trad.segmentsTraducido && trad.rawTextTraducido !== null) {
    return {
      ...original,
      segments: trad.segmentsTraducido,
      raw_text: trad.rawTextTraducido,
      language: trad.traducidoA ?? TARGET_LANG,
    }
  }
  return original
}
