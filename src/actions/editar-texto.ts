'use server'

// =============================================================================
// Server action — Editar el texto de una transcripción
// =============================================================================
// Corrige errores de transcripción (nombres propios, términos, typos) editando
// el texto de segmentos individuales. Al guardar:
//   1. Persiste los segmentos editados + reconstruye raw_text (base del análisis,
//      PDF y búsqueda full-text).
//   2. Re-indexa el RAG (reusa indexarTranscripcion) para que el Ask refleje el
//      texto corregido y NO herede el error.
//   3. Marca `texto_editado_en` → la UI avisa que el análisis quedó hecho sobre
//      el texto anterior (re-analizar es opcional, con la acción existente).
//
// Alcance: solo transcripciones SIN traducción (segments_traducido null). Editar
// una traducida desincronizaría original↔traducción — se rechaza (la UI oculta
// el botón en ese caso). El texto editado es el ORIGINAL (segments).
// =============================================================================

import { revalidatePath } from 'next/cache'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { indexarTranscripcion } from './transcripciones'

/** Cap de caracteres por segmento (defensa anti-payload abusivo). */
const SEG_TEXT_MAX = 5_000

export interface EdicionSegmento {
  index: number
  text: string
}

export interface EditarTextoResult {
  ok: boolean
  mensaje?: string
  errorMessage?: string
  reindexado?: boolean
}

interface Segmento {
  speaker: { id: number; label?: string }
  text: string
  start_ms: number
  end_ms: number
  confidence: number
}

/**
 * Limpia el texto de un segmento: quita caracteres de control filtrando por
 * codepoint (NUNCA una regex con bytes de control literales — regla dura del
 * workspace, mismo patrón que limpiarTexto de multifuente.ts), colapsa espacios
 * y recorta. Devuelve '' si tras limpiar queda vacío (el caller lo ignora).
 */
function sanitizarSegmento(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return Array.from(raw)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 32 && c !== 127 // descarta control chars (incluye saltos/tabs)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEG_TEXT_MAX)
}

export async function editarTextoTranscripcion(
  transcripcionId: string,
  ediciones: EdicionSegmento[],
): Promise<EditarTextoResult> {
  if (!transcripcionId || transcripcionId.length < 10) {
    return { ok: false, errorMessage: 'Identificador inválido.' }
  }
  if (!Array.isArray(ediciones) || ediciones.length === 0) {
    return { ok: false, errorMessage: 'No hay cambios para guardar.' }
  }

  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, errorMessage: 'No autenticado.' }

  // RLS filtra por user_id.
  const { data, error } = await supabase
    .from('transcripciones')
    .select('id, estado, segments, segments_traducido')
    .eq('id', transcripcionId)
    .single()
  if (error || !data) {
    return { ok: false, errorMessage: 'Transcripción no encontrada o sin permisos.' }
  }
  if (data.estado !== 'completado') {
    return { ok: false, errorMessage: 'Solo se puede editar el texto de una transcripción completada.' }
  }
  if (Array.isArray(data.segments_traducido) && data.segments_traducido.length > 0) {
    return {
      ok: false,
      errorMessage: 'La edición no está disponible para transcripciones traducidas (evita desincronizar original y traducción).',
    }
  }
  if (!Array.isArray(data.segments) || data.segments.length === 0) {
    return { ok: false, errorMessage: 'Esta transcripción no tiene segmentos editables.' }
  }

  // Aplicar ediciones sobre una copia (solo el campo text; preserva speaker/timings).
  const segments = (data.segments as Segmento[]).map((s) => ({ ...s }))
  let cambiados = 0
  for (const ed of ediciones) {
    if (!ed || typeof ed.index !== 'number' || ed.index < 0 || ed.index >= segments.length) continue
    const limpio = sanitizarSegmento(ed.text)
    if (limpio.length === 0) continue // no permitimos vaciar un segmento
    if (segments[ed.index]!.text === limpio) continue // sin cambio real
    segments[ed.index]!.text = limpio
    cambiados++
  }
  if (cambiados === 0) {
    return { ok: false, errorMessage: 'Los cambios no modifican el texto.' }
  }

  // raw_text canónico = texto de los segmentos en orden (base de búsqueda + PDF).
  const rawText = segments.map((s) => s.text).join('\n')

  const { error: updErr } = await supabase
    .from('transcripciones')
    .update({
      segments,
      raw_text: rawText,
      texto_editado_en: new Date().toISOString(),
    })
    .eq('id', transcripcionId)
  if (updErr) {
    return { ok: false, errorMessage: `No se pudo guardar: ${updErr.message}` }
  }

  // Re-indexar el RAG para que el Ask refleje el texto corregido (best-effort:
  // si falla, el texto editado ya quedó guardado; el Ask se puede re-indexar luego).
  let reindexado = false
  try {
    const res = await indexarTranscripcion(transcripcionId)
    reindexado = res.ok
  } catch {
    reindexado = false
  }

  revalidatePath(`/dashboard/transcripcion/${transcripcionId}`)
  revalidatePath('/dashboard')

  return {
    ok: true,
    reindexado,
    mensaje: `Texto actualizado (${cambiados} ${cambiados === 1 ? 'segmento' : 'segmentos'}).${reindexado ? '' : ' (El índice de búsqueda se re-generará luego.)'}`,
  }
}
