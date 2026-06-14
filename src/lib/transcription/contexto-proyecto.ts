import 'server-only'

// =============================================================================
// Contexto del proyecto para re-analisis con memoria global
//
// =============================================================================
// Construye el bloque de CONTEXTO que se inyecta al prompt del re-analisis de
// una sesion para que el analisis considere el HISTORICO de la relacion, no solo
// la reunion de hoy. Resuelve el limite de tokens usando RESUMENES (la memoria
// del proyecto + resumenes de sesiones), nunca transcripciones completas.
//
// Eje 2 (alcance temporal) = cuanto historico abarcar:
//   - 'ninguno'   → sin contexto (comportamiento clasico del re-analisis).
//   - 'memoria'   → solo la memoria del proyecto (sintesis de TODO el historico,
//                   5B-B). La opcion mas economica que aun cubre todo. Si el
//                   proyecto no tiene memoria generada, cae a los resumenes de
//                   las ultimas sesiones (fallback).
//   - 'detallado' → memoria del proyecto + resumenes completos de las ultimas
//                   N sesiones (mas detalle reciente, mas tokens).
//
// Siempre EXCLUYE la sesion que se esta re-analizando (no se cita a si misma) y
// solo considera sesiones 'completado' con analisis.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverTokensSpeakerTexto, type SpeakerNames } from './speaker-names'

export type ContextoProyectoScope = 'ninguno' | 'memoria' | 'detallado'

/** Cuantas sesiones recientes detalla el modo 'detallado' (protege consumo IA). */
const SESIONES_DETALLE = 5
/** Cuantas sesiones se usan como fallback si 'memoria' no tiene memoria generada. */
const SESIONES_FALLBACK = 3
/** Tope de caracteres del resumen de cada sesion inyectada (defensa anti-tokens). */
const MAX_CHARS_RESUMEN = 1200

export interface ContextoProyectoResult {
  /** Bloque de contexto listo para inyectar, o null si no hay nada que aportar. */
  contexto: string | null
  /** Cuantas sesiones (distintas a la actual) se incluyeron con su resumen. */
  sesionesIncluidas: number
  /** Si se incluyo la memoria sintetizada del proyecto. */
  usoMemoria: boolean
}

function esRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Construye el contexto del proyecto para el re-analisis de una sesion.
 * RLS de proyectos/transcripciones filtra por usuario; ademas el caller ya
 * verifico ownership de la sesion.
 */
export async function construirContextoProyecto(
  supabase: SupabaseClient,
  opts: {
    proyectoId: string
    /** Sesion que se re-analiza: se excluye del contexto. */
    excluirTranscripcionId: string
    scope: ContextoProyectoScope
  },
): Promise<ContextoProyectoResult> {
  const vacio: ContextoProyectoResult = {
    contexto: null,
    sesionesIncluidas: 0,
    usoMemoria: false,
  }
  if (opts.scope === 'ninguno' || !opts.proyectoId) return vacio

  // ---- Memoria del proyecto (sintesis de TODO el historico, 5B-B).
  const { data: proyecto } = await supabase
    .from('proyectos')
    .select('nombre, memoria_resumen')
    .eq('id', opts.proyectoId)
    .single()
  if (!proyecto) return vacio

  const memoria =
    typeof proyecto.memoria_resumen === 'string' && proyecto.memoria_resumen.trim().length > 0
      ? proyecto.memoria_resumen.trim()
      : null

  const partes: string[] = []
  let usoMemoria = false
  if (memoria) {
    partes.push(`MEMORIA DEL PROYECTO (sintesis de todas las sesiones):\n${memoria}`)
    usoMemoria = true
  }

  // ---- Resumenes de sesiones segun el alcance.
  //   'detallado'           → ultimas SESIONES_DETALLE.
  //   'memoria' sin memoria → fallback a ultimas SESIONES_FALLBACK.
  //   'memoria' con memoria → 0 resumenes extra (la memoria ya cubre el historico).
  let limiteSesiones = 0
  if (opts.scope === 'detallado') limiteSesiones = SESIONES_DETALLE
  else if (opts.scope === 'memoria' && !memoria) limiteSesiones = SESIONES_FALLBACK

  let sesionesIncluidas = 0
  if (limiteSesiones > 0) {
    const { data: sesiones } = await supabase
      .from('transcripciones')
      .select('id, titulo, created_at, analisis, speaker_names')
      .eq('proyecto_id', opts.proyectoId)
      .eq('estado', 'completado')
      .neq('id', opts.excluirTranscripcionId)
      .order('created_at', { ascending: false })
      .limit(limiteSesiones)

    const conAnalisis = (sesiones ?? []).filter((s) => (s as { analisis?: unknown }).analisis != null)
    // Orden cronologico ascendente para el prompt (de lo mas viejo a lo mas nuevo).
    conAnalisis.reverse()

    const bloques: string[] = []
    for (const s of conAnalisis) {
      const an = (s as { analisis?: unknown }).analisis
      if (!esRecord(an)) continue
      const names = esRecord((s as { speaker_names?: unknown }).speaker_names)
        ? ((s as { speaker_names?: unknown }).speaker_names as SpeakerNames)
        : null
      const resumen = resolverTokensSpeakerTexto(String(an.resumen ?? ''), names)
        .trim()
        .slice(0, MAX_CHARS_RESUMEN)
      if (resumen.length === 0) continue
      const fecha = new Date(s.created_at as string).toLocaleDateString('es-MX', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
      bloques.push(`- ${s.titulo as string} (${fecha}): ${resumen}`)
      sesionesIncluidas += 1
    }

    if (bloques.length > 0) {
      partes.push(`SESIONES PREVIAS DEL PROYECTO (resumenes, cronologico):\n${bloques.join('\n')}`)
    }
  }

  if (partes.length === 0) return vacio

  return {
    contexto: partes.join('\n\n'),
    sesionesIncluidas,
    usoMemoria,
  }
}
