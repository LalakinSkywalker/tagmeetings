// =============================================================================
// PRP-TT-V2 Fase 6 — Modelo normalizado de export
// =============================================================================
// Fuente unica de los datos que cualquier formato de export consume (TXT, MD,
// SRT, DOCX, PDF) y que tambien alimenta el archivado en Drive (Fase 6C). Toma
// la fila cruda de `transcripciones` y produce un objeto limpio con:
//   - nombres reales de hablante ya resueltos (Speaker N / nombre del roster),
//   - marcadores {{sN}} del analisis sustituidos,
//   - la version a mostrar (traduccion al espanol cuando existe, si no original).
//
// Es ISOMORFICO (sin server-only): se usa en el cliente para generar descargas y
// en el server para subir a Drive. NO toca BD ni storage.
// =============================================================================

import {
  resolveSpeakerName,
  resolverTokensSpeakerDeep,
  type SpeakerNames,
} from '@/lib/transcription/speaker-names'
import { nombreIdioma } from '@/lib/transcription/idioma-display'

export interface ExportSegment {
  startMs: number
  endMs: number
  speakerId: number | null
  /** Nombre real resuelto (o "Speaker N"). */
  speaker: string
  text: string
}

export interface ExportActionItem {
  texto: string
  owner: string | null
  dueDate: string | null
}

export interface ExportAnalisis {
  resumen: string
  bullets: string[]
  actionItems: ExportActionItem[]
  customFields: Record<string, unknown>
  categoria: string
  modelUsed: string
  costUsd: number
}

export interface ExportMeta {
  titulo: string
  createdAt: string | null
  completedAt: string | null
  duracionMs: number | null
  /** Nombre legible del idioma de origen (detectado o solicitado). */
  idiomaOrigen: string | null
  /** Nombre legible del idioma destino si hubo traduccion, si no null. */
  idiomaDestino: string | null
  plantillaNombre: string
  modoAnalisis: string | null
  categoria: string | null
  costoUsdTotal: number | null
}

export interface ExportData {
  meta: ExportMeta
  analisis: ExportAnalisis | null
  /** Segments de la version a mostrar (traduccion si existe, si no original). */
  segments: ExportSegment[]
  /** Texto plano de respaldo cuando no hay segments. */
  rawText: string | null
}

/** Fila de `transcripciones` que el export necesita (subconjunto del select). */
export interface TranscripcionExportInput {
  titulo: string
  raw_text: string | null
  raw_text_traducido?: string | null
  segments: unknown
  segments_traducido?: unknown
  analisis: unknown
  categoria: string | null
  duracion_ms: number | null
  idioma: string | null
  idioma_detectado?: string | null
  traducido_a?: string | null
  cost_usd_total: number | null
  created_at: string
  completed_at: string | null
  speaker_names?: SpeakerNames | null
  modo_analisis?: string | null
}

interface RawSeg {
  speaker?: { id?: number | null }
  text?: string
  start_ms?: number
  end_ms?: number
}

interface RawAnalisis {
  resumen?: unknown
  bullets?: unknown
  action_items?: unknown
  custom_fields?: unknown
  categoria?: unknown
  model_used?: unknown
  cost_usd?: unknown
}

function toSegments(raw: unknown): RawSeg[] {
  return Array.isArray(raw) ? (raw as RawSeg[]) : []
}

function toActionItem(v: unknown): ExportActionItem {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    texto: typeof o.texto === 'string' ? o.texto : '',
    owner: typeof o.owner === 'string' && o.owner.trim() ? o.owner : null,
    dueDate: typeof o.due_date === 'string' && o.due_date.trim() ? o.due_date : null,
  }
}

/**
 * Normaliza una fila de transcripcion al modelo de export, resolviendo nombres
 * de hablante y marcadores {{sN}}. Pura: no lanza, degrada a vacios.
 */
export function buildExportData(
  t: TranscripcionExportInput,
  plantillaNombre: string,
): ExportData {
  const speakerNames: SpeakerNames =
    t.speaker_names && typeof t.speaker_names === 'object' ? t.speaker_names : {}

  const original = toSegments(t.segments)
  const traducidos = toSegments(t.segments_traducido)
  const hayTraduccion = traducidos.length > 0 && Boolean(t.traducido_a)
  const display = hayTraduccion ? traducidos : original

  const segments: ExportSegment[] = display.map((s) => {
    const id = typeof s.speaker?.id === 'number' ? s.speaker.id : null
    return {
      startMs: typeof s.start_ms === 'number' ? s.start_ms : 0,
      endMs: typeof s.end_ms === 'number' ? s.end_ms : 0,
      speakerId: id,
      speaker: resolveSpeakerName(id, speakerNames),
      text: typeof s.text === 'string' ? s.text : '',
    }
  })

  let analisis: ExportAnalisis | null = null
  if (t.analisis && typeof t.analisis === 'object') {
    const a = resolverTokensSpeakerDeep(t.analisis, speakerNames) as RawAnalisis
    analisis = {
      resumen: typeof a.resumen === 'string' ? a.resumen : '',
      bullets: Array.isArray(a.bullets)
        ? a.bullets.filter((x): x is string => typeof x === 'string')
        : [],
      actionItems: Array.isArray(a.action_items)
        ? a.action_items.map(toActionItem)
        : [],
      customFields:
        a.custom_fields && typeof a.custom_fields === 'object'
          ? (a.custom_fields as Record<string, unknown>)
          : {},
      categoria: typeof a.categoria === 'string' ? a.categoria : (t.categoria ?? ''),
      modelUsed: typeof a.model_used === 'string' ? a.model_used : '',
      costUsd: typeof a.cost_usd === 'number' ? a.cost_usd : 0,
    }
  }

  const rawTextDisplay =
    hayTraduccion && t.raw_text_traducido ? t.raw_text_traducido : t.raw_text

  const idiomaOrigenCode = t.idioma_detectado ?? t.idioma
  const meta: ExportMeta = {
    titulo: t.titulo,
    createdAt: t.created_at ?? null,
    completedAt: t.completed_at ?? null,
    duracionMs: t.duracion_ms ?? null,
    idiomaOrigen: nombreIdioma(idiomaOrigenCode),
    idiomaDestino: hayTraduccion ? nombreIdioma(t.traducido_a) : null,
    plantillaNombre,
    modoAnalisis: t.modo_analisis ?? null,
    categoria: t.categoria ?? null,
    costoUsdTotal: t.cost_usd_total ?? null,
  }

  return { meta, analisis, segments, rawText: rawTextDisplay ?? null }
}
