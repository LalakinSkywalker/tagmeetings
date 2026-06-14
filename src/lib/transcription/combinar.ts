import type { TranscriptionResult } from '@bluntag/transcription-core'
import type { SpeakerNames } from './speaker-names'

// =============================================================================
// combinar — fusiona N fuentes (audio/video/pdf/doc) en UN TranscriptionResult
// =============================================================================
// DECISIÓN DE DISEÑO DEL MERGE:
//
//   1. HABLANTES cross-archivo NO se intentan emparejar. Deepgram diariza por
//      archivo de forma independiente: el "Speaker 0" del audio A NO es el
//      "Speaker 0" del audio B. Emparejarlos requeriría voice-matching que
//      Deepgram no ofrece. En su lugar, NAMESPACEAMOS los hablantes por fuente:
//      el id combinado = orden*SPEAKER_NS + idOriginal (orden 0 → 0..99,
//      orden 1 → 100..199, ...). Así cada hablante de cada fuente es distinto.
//      Se auto-poblan nombres legibles ("F1 · Hablante 0") en speaker_names del
//      padre; el usuario puede renombrarlos con el mecanismo existente.
//
//   2. TIMELINE ordenado: las fuentes se concatenan en orden (`orden`), y los
//      timings de cada fuente se desplazan por la duración acumulada de las
//      anteriores → línea de tiempo monótona y coherente.
//
//   3. CONTEXTO de fuente para el LLM: el primer segmento de cada fuente lleva
//      un encabezado "[— Fuente N: nombre —]" inyectado en su texto, para que
//      el modelo entienda que el material viene de varias grabaciones/documentos.
//
//   4. DOCUMENTOS (pdf/doc/texto): no tienen diarización; se inyectan como un
//      pseudo-segmento de texto al final de la línea de tiempo (hablante
//      "Documento: nombre"), para que su contenido SÍ entre al análisis (el
//      motor analiza sobre segments cuando existen).
// =============================================================================

const SPEAKER_NS = 100
const DOC_SPEAKER_BASE = 9000

interface RawSegment {
  speaker?: { id?: number | null; label?: string }
  text?: string
  start_ms?: number
  end_ms?: number
  confidence?: number
}

export interface FuenteParaCombinar {
  orden: number
  tipo: 'audio' | 'video' | 'pdf' | 'doc' | 'texto'
  nombre: string
  segments?: unknown
  texto_extraido?: string | null
  duracion_ms?: number | null
}

export interface CombinarResult {
  transcription: TranscriptionResult
  speakerNames: SpeakerNames
}

function etiquetaTipo(tipo: FuenteParaCombinar['tipo']): string {
  switch (tipo) {
    case 'audio':
      return 'audio'
    case 'video':
      return 'video'
    case 'pdf':
      return 'PDF'
    case 'doc':
      return 'documento'
    case 'texto':
      return 'texto'
  }
}

function maxEnd(segs: RawSegment[]): number {
  let max = 0
  for (const s of segs) {
    if (typeof s.end_ms === 'number' && s.end_ms > max) max = s.end_ms
  }
  return max
}

/**
 * Combina las fuentes (ya ordenadas o no) en un único TranscriptionResult listo
 * para traducir/analizar/indexar, más el diccionario speaker_names auto-poblado.
 */
export function combinarFuentes(fuentes: FuenteParaCombinar[]): CombinarResult {
  const ordenadas = [...fuentes].sort((a, b) => a.orden - b.orden)

  const segments: TranscriptionResult['segments'] = []
  const rawParts: string[] = []
  const speakerNames: SpeakerNames = {}
  let cursorMs = 0
  let docIdx = 0

  for (const f of ordenadas) {
    const nfuente = f.orden + 1
    const header = `— Fuente ${nfuente}: ${f.nombre} (${etiquetaTipo(f.tipo)}) —`
    const esAudio =
      (f.tipo === 'audio' || f.tipo === 'video') &&
      Array.isArray(f.segments) &&
      (f.segments as RawSegment[]).length > 0

    if (esAudio) {
      const segs = f.segments as RawSegment[]
      const dur = f.duracion_ms ?? maxEnd(segs)
      const lines: string[] = []
      let first = true
      for (const s of segs) {
        const origId = typeof s.speaker?.id === 'number' ? s.speaker.id : 0
        const nsId = f.orden * SPEAKER_NS + origId
        const label = `F${nfuente} · Hablante ${origId}`
        speakerNames[String(nsId)] = label
        const baseText = typeof s.text === 'string' ? s.text : ''
        segments.push({
          speaker: { id: nsId, label },
          text: first ? `[${header}] ${baseText}` : baseText,
          start_ms: cursorMs + (s.start_ms ?? 0),
          end_ms: cursorMs + (s.end_ms ?? 0),
          confidence: typeof s.confidence === 'number' ? s.confidence : 0.9,
        })
        lines.push(`[${label}] ${baseText}`)
        first = false
      }
      rawParts.push(`=== ${header} ===\n${lines.join('\n')}`)
      cursorMs += dur > 0 ? dur : 0
    } else {
      // Documento (pdf/doc/texto) → pseudo-segmento de texto.
      const texto = (f.texto_extraido ?? '').trim()
      if (texto.length === 0) continue
      const docId = DOC_SPEAKER_BASE + docIdx
      speakerNames[String(docId)] = `Documento: ${f.nombre}`
      segments.push({
        speaker: { id: docId, label: `Documento: ${f.nombre}` },
        text: `[${header}]\n${texto}`,
        start_ms: cursorMs,
        end_ms: cursorMs,
        confidence: 1,
      })
      rawParts.push(`=== ${header} ===\n${texto}`)
      docIdx++
    }
  }

  return {
    transcription: {
      segments,
      language: 'es-MX',
      duration_ms: cursorMs,
      raw_text: rawParts.join('\n\n'),
      provider: 'multifuente',
    },
    speakerNames,
  }
}
