// =============================================================================
// PRP-TT-003 — Resolucion de nombres reales de hablantes
// =============================================================================
// Unica fuente de verdad del fallback "Speaker N". Se reutiliza en:
//   - transcripcion-detalle.tsx (render de la transcripcion)
//   - ask-panel.tsx (chips de citas del Ask)
// El diccionario vive en transcripciones.speaker_names (JSONB) y se resuelve en
// runtime — NO se persiste el nombre dentro de cada segment ni se re-indexa.
// =============================================================================

/** Mapa { "<speaker_id>": "<nombre real>" } persistido por transcripcion. */
export type SpeakerNames = Record<string, string>

/**
 * Resuelve el nombre a mostrar para un hablante.
 * - Si hay nombre real no vacio en el diccionario -> ese nombre.
 * - Si el id es valido pero sin nombre -> "Speaker N".
 * - Si el id es null/undefined (cita sin speaker) -> "Speaker ?".
 */
export function resolveSpeakerName(
  speakerId: number | null | undefined,
  dict: SpeakerNames | null | undefined,
): string {
  if (speakerId === null || speakerId === undefined || Number.isNaN(speakerId)) {
    return 'Speaker ?'
  }
  const name = dict?.[String(speakerId)]
  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim()
  }
  return `Speaker ${speakerId}`
}

/** Marcador estable de hablante que el motor escribe en el analisis: {{s0}}, {{s1}}… */
const SPEAKER_TOKEN_RE = /\{\{s(\d+)\}\}/g

/**
 * Sustituye los marcadores {{sN}} de un texto por el nombre real del hablante
 * (PRP-TT-V2 Fase 5). Si el texto no trae marcadores, lo devuelve igual. Util
 * para resumenes/bullets que el motor guardo en modo marcador.
 */
export function resolverTokensSpeakerTexto(
  texto: string,
  dict: SpeakerNames | null | undefined,
): string {
  if (typeof texto !== 'string' || texto.length === 0) return texto
  return texto.replace(SPEAKER_TOKEN_RE, (_m, d: string) =>
    resolveSpeakerName(Number(d), dict),
  )
}

/**
 * Sustituye los marcadores {{sN}} de forma RECURSIVA sobre strings/arrays/objetos
 * (PRP-TT-V2 Fase 5). Resumen, bullets, action items y custom_fields del analisis
 * llevan los marcadores; esto los resuelve a nombres reales en cualquier nivel de
 * anidamiento. Si un valor no es string/array/objeto, lo devuelve igual. Renombrar
 * un hablante refleja el cambio al instante — SIN re-analizar (cero costo de IA).
 *
 * Unica fuente de verdad del resolver profundo: lo usan el render del detalle
 * (transcripcion-detalle.tsx) y el motor de export (lib/export).
 */
export function resolverTokensSpeakerDeep(
  value: unknown,
  dict: SpeakerNames | null | undefined,
): unknown {
  if (typeof value === 'string') return resolverTokensSpeakerTexto(value, dict)
  if (Array.isArray(value)) return value.map((v) => resolverTokensSpeakerDeep(v, dict))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolverTokensSpeakerDeep(v, dict)
    }
    return out
  }
  return value
}

/** Extrae los ids de hablante unicos presentes en los segments, ordenados asc. */
export function uniqueSpeakerIds(
  segments: ReadonlyArray<{ speaker?: { id?: number | null } }>,
): number[] {
  const set = new Set<number>()
  for (const seg of segments) {
    const id = seg?.speaker?.id
    if (typeof id === 'number' && Number.isFinite(id)) {
      set.add(id)
    }
  }
  return Array.from(set).sort((a, b) => a - b)
}

// =============================================================================
// Multi-fuente — origen de cada hablante (PRP-TT — Hueco B)
// =============================================================================
// DEBEN coincidir con combinar.ts (SPEAKER_NS / DOC_SPEAKER_BASE). combinar.ts
// genera ids namespaced: nsId = orden * SPEAKER_NS + origId (audio), y los
// documentos en DOC_SPEAKER_BASE + indice. Aqui derivamos de vuelta el origen
// para agrupar los hablantes por fuente en el panel de Participantes.
// =============================================================================

/** Tamaño del namespace de hablantes por fuente de audio (combinar.ts SPEAKER_NS). */
export const SPEAKER_SOURCE_NS = 100
/** Base de ids para hablantes "Documento" (combinar.ts DOC_SPEAKER_BASE). */
export const DOC_SPEAKER_BASE = 9000

export interface SpeakerOrigin {
  kind: 'audio' | 'documento'
  /** Índice 0-based de la fuente (= `orden` de la fuente para audio). */
  sourceIndex: number
  /** Id original del hablante dentro de su fuente (el que Deepgram asignó). */
  origId: number
}

/** Descompone un id namespaced en su fuente + id original (inverso de combinar.ts). */
export function parseSpeakerOrigin(id: number): SpeakerOrigin {
  if (id >= DOC_SPEAKER_BASE) {
    const idx = id - DOC_SPEAKER_BASE
    return { kind: 'documento', sourceIndex: idx, origId: idx }
  }
  return {
    kind: 'audio',
    sourceIndex: Math.floor(id / SPEAKER_SOURCE_NS),
    origId: id % SPEAKER_SOURCE_NS,
  }
}

/**
 * True si los ids provienen de una sesión multi-fuente. El namespacing de
 * combinar.ts garantiza que una sesión de una sola fuente solo produce ids
 * pequeños (< SPEAKER_SOURCE_NS); cualquier id ≥ 100 (segunda fuente) o ≥ 9000
 * (documento) implica multi-fuente.
 */
export function esMultifuentePorIds(speakerIds: number[]): boolean {
  return speakerIds.some((id) => id >= SPEAKER_SOURCE_NS)
}
