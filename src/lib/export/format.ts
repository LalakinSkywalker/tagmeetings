// =============================================================================
// Helpers de formato + builders de texto (TXT / MD / SRT)
// =============================================================================
// Builders puros e isomorficos. A partir de un ExportData producen el string de
// cada formato de texto. DOCX y PDF viven en modulos aparte (usan librerias).
// =============================================================================

import type { ExportData, ExportSegment } from './export-data'

/** Contenido que se puede exportar. */
export type ExportContent = 'analisis' | 'transcripcion' | 'paquete'
/** Formato de archivo. */
export type ExportFormat = 'txt' | 'md' | 'srt' | 'docx' | 'pdf'

export interface TranscripcionOpts {
  /** Anteponer el timestamp [MM:SS] a cada intervencion. */
  incluirTimestamps: boolean
  /** Anteponer el nombre del hablante a cada intervencion. */
  incluirHablantes: boolean
}

export const TRANSCRIPCION_OPTS_DEFAULT: TranscripcionOpts = {
  incluirTimestamps: true,
  incluirHablantes: true,
}

// -----------------------------------------------------------------------------
// Tiempo
// -----------------------------------------------------------------------------

/** "M:SS" para <1h, "H:MM:SS" para >=1h. Corrige el bug "60:16" -> "1:00:16". */
export function formatTimestampSmart(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Duracion legible (igual escala que formatTimestampSmart). */
export function formatDuracion(ms: number | null): string {
  if (!ms || ms <= 0) return '—'
  return formatTimestampSmart(ms)
}

/** Timecode SRT "HH:MM:SS,mmm". */
export function formatSrtTimecode(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms))
  const h = Math.floor(clamped / 3_600_000)
  const m = Math.floor((clamped % 3_600_000) / 60_000)
  const s = Math.floor((clamped % 60_000) / 1000)
  const millis = clamped % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/** Fecha legible en es-MX ("1 de junio de 2026"). */
export function formatFechaLegible(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d)
  } catch {
    return iso.slice(0, 10)
  }
}

/** Capitaliza una clave snake_case del analisis ("siguiente_paso" -> "Siguiente Paso"). */
export function formatCustomFieldKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// -----------------------------------------------------------------------------
// Nombre de archivo
// -----------------------------------------------------------------------------

/** Etiquetas legibles de cada contenido descargable (para el nombre de archivo). */
export const CONTENIDO_LABEL = {
  analisis: 'Análisis',
  transcripcion: 'Transcripción',
  audio: 'Audio',
  paquete: 'Paquete',
} as const

/**
 * Limpia un titulo para usarlo como nombre de archivo LEGIBLE: conserva acentos,
 * espacios y mayusculas (los SO modernos los soportan), solo quita los caracteres
 * que el FS prohibe (/ \ : * ? " < > |) y los de control. Asi el archivo dice
 * claramente que es, en vez de un slug tipo codigo.
 */
export function tituloParaArchivo(titulo: string): string {
  const limpio = (titulo || 'Transcripción')
    .replace(/[\\/:*?"<>|]/g, ' ')
    // control chars (U+0000-U+001F) sin teclearlos literales (regla del workspace)
    .split('')
    .filter((ch) => (ch.codePointAt(0) ?? 32) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return limpio.length > 0 ? limpio : 'Transcripción'
}

/** Nombre de archivo claro: "<Titulo> - <Etiqueta>.<ext>". */
export function nombreArchivo(titulo: string, etiqueta: string, ext: string): string {
  return `${tituloParaArchivo(titulo)} - ${etiqueta}.${ext}`
}

// -----------------------------------------------------------------------------
// Lineas de metadatos (compartidas por TXT/MD)
// -----------------------------------------------------------------------------

/** Pares etiqueta/valor de la cabecera. Omite los vacios. */
export function metaPairs(data: ExportData): Array<[string, string]> {
  const { meta } = data
  const pairs: Array<[string, string]> = []
  const fecha = formatFechaLegible(meta.createdAt)
  if (fecha) pairs.push(['Fecha', fecha])
  if (meta.plantillaNombre) pairs.push(['Plantilla', meta.plantillaNombre])
  if (meta.duracionMs) pairs.push(['Duración', formatDuracion(meta.duracionMs)])
  if (meta.idiomaOrigen) {
    pairs.push([
      'Idioma',
      meta.idiomaDestino ? `${meta.idiomaOrigen} → ${meta.idiomaDestino}` : meta.idiomaOrigen,
    ])
  }
  if (meta.categoria) pairs.push(['Categoría', meta.categoria])
  return pairs
}

// -----------------------------------------------------------------------------
// Linea de una intervencion de la transcripcion
// -----------------------------------------------------------------------------

function segmentLine(seg: ExportSegment, opts: TranscripcionOpts): string {
  const prefijo: string[] = []
  if (opts.incluirTimestamps) prefijo.push(`[${formatTimestampSmart(seg.startMs)}]`)
  if (opts.incluirHablantes) prefijo.push(`${seg.speaker}:`)
  const head = prefijo.join(' ')
  return head ? `${head} ${seg.text}` : seg.text
}

// -----------------------------------------------------------------------------
// TXT
// -----------------------------------------------------------------------------

export function buildAnalisisTxt(data: ExportData): string {
  const { meta, analisis } = data
  const out: string[] = []
  out.push(meta.titulo.toUpperCase())
  out.push('='.repeat(Math.min(60, Math.max(8, meta.titulo.length))))
  for (const [k, v] of metaPairs(data)) out.push(`${k}: ${v}`)
  out.push('')
  if (!analisis) {
    out.push('(Sin análisis disponible)')
    return out.join('\n')
  }
  if (analisis.resumen) {
    out.push('RESUMEN')
    out.push('-------')
    out.push(analisis.resumen)
    out.push('')
  }
  if (analisis.bullets.length > 0) {
    out.push('PUNTOS CLAVE')
    out.push('------------')
    for (const b of analisis.bullets) out.push(`• ${b}`)
    out.push('')
  }
  if (analisis.actionItems.length > 0) {
    out.push('ACTION ITEMS')
    out.push('------------')
    for (const ai of analisis.actionItems) {
      const extra: string[] = []
      if (ai.owner) extra.push(`Responsable: ${ai.owner}`)
      if (ai.dueDate) extra.push(`Para: ${ai.dueDate}`)
      out.push(`• ${ai.texto}${extra.length ? ` (${extra.join(' · ')})` : ''}`)
    }
    out.push('')
  }
  const cf = Object.entries(analisis.customFields)
  if (cf.length > 0) {
    for (const [key, val] of cf) {
      out.push(formatCustomFieldKey(key).toUpperCase())
      out.push('-'.repeat(Math.max(8, key.length)))
      out.push(...customFieldLines(val))
      out.push('')
    }
  }
  out.push('—'.repeat(20))
  out.push(`Generado por TagMeetings${analisis.modelUsed ? ` · Modelo: ${analisis.modelUsed}` : ''}`)
  return out.join('\n')
}

export function buildTranscripcionTxt(data: ExportData, opts: TranscripcionOpts): string {
  const out: string[] = []
  out.push(`${data.meta.titulo.toUpperCase()} — TRANSCRIPCIÓN`)
  out.push('='.repeat(40))
  for (const [k, v] of metaPairs(data)) out.push(`${k}: ${v}`)
  out.push('')
  if (data.segments.length > 0) {
    for (const seg of data.segments) out.push(segmentLine(seg, opts))
  } else if (data.rawText) {
    out.push(data.rawText)
  } else {
    out.push('(Sin transcripción disponible)')
  }
  return out.join('\n')
}

function customFieldLines(val: unknown): string[] {
  if (Array.isArray(val)) {
    if (val.length === 0) return ['(vacío)']
    return val.map((v) => `• ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  if (typeof val === 'string') return [val]
  if (val === null || val === undefined) return ['(vacío)']
  return [JSON.stringify(val, null, 2)]
}

// -----------------------------------------------------------------------------
// Markdown
// -----------------------------------------------------------------------------

export function buildAnalisisMarkdown(data: ExportData): string {
  const { meta, analisis } = data
  const out: string[] = []
  out.push(`# ${meta.titulo}`)
  out.push('')
  const pairs = metaPairs(data)
  if (pairs.length > 0) {
    out.push(pairs.map(([k, v]) => `**${k}:** ${v}`).join('  \n'))
    out.push('')
  }
  if (!analisis) {
    out.push('_Sin análisis disponible._')
    return out.join('\n')
  }
  if (analisis.resumen) {
    out.push('## Resumen')
    out.push('')
    out.push(analisis.resumen)
    out.push('')
  }
  if (analisis.bullets.length > 0) {
    out.push('## Puntos clave')
    out.push('')
    for (const b of analisis.bullets) out.push(`- ${b}`)
    out.push('')
  }
  if (analisis.actionItems.length > 0) {
    out.push('## Action items')
    out.push('')
    for (const ai of analisis.actionItems) {
      const extra: string[] = []
      if (ai.owner) extra.push(`Responsable: ${ai.owner}`)
      if (ai.dueDate) extra.push(`Para: ${ai.dueDate}`)
      out.push(`- **${ai.texto}**${extra.length ? ` — _${extra.join(' · ')}_` : ''}`)
    }
    out.push('')
  }
  for (const [key, val] of Object.entries(analisis.customFields)) {
    out.push(`## ${formatCustomFieldKey(key)}`)
    out.push('')
    out.push(...customFieldMarkdown(val))
    out.push('')
  }
  out.push('---')
  out.push(
    `_Generado por TagMeetings${analisis.modelUsed ? ` · Modelo: ${analisis.modelUsed}` : ''}_`,
  )
  return out.join('\n')
}

function customFieldMarkdown(val: unknown): string[] {
  if (Array.isArray(val)) {
    if (val.length === 0) return ['_(vacío)_']
    return val.map((v) => `- ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  }
  if (typeof val === 'string') return [val]
  if (val === null || val === undefined) return ['_(vacío)_']
  return ['```json', JSON.stringify(val, null, 2), '```']
}

export function buildTranscripcionMarkdown(data: ExportData, opts: TranscripcionOpts): string {
  const out: string[] = []
  out.push(`# ${data.meta.titulo} — Transcripción`)
  out.push('')
  const pairs = metaPairs(data)
  if (pairs.length > 0) {
    out.push(pairs.map(([k, v]) => `**${k}:** ${v}`).join('  \n'))
    out.push('')
  }
  if (data.segments.length > 0) {
    for (const seg of data.segments) {
      const ts = opts.incluirTimestamps ? `\`${formatTimestampSmart(seg.startMs)}\` ` : ''
      const sp = opts.incluirHablantes ? `**${seg.speaker}:** ` : ''
      out.push(`${ts}${sp}${seg.text}`)
      out.push('')
    }
  } else if (data.rawText) {
    out.push(data.rawText)
  } else {
    out.push('_Sin transcripción disponible._')
  }
  return out.join('\n')
}

// -----------------------------------------------------------------------------
// SRT (subtitulos) — solo aplica a la transcripcion
// -----------------------------------------------------------------------------

export function buildTranscripcionSrt(data: ExportData, opts: TranscripcionOpts): string {
  const segs = data.segments
  if (segs.length === 0) return ''
  const cues: string[] = []
  segs.forEach((seg, i) => {
    const start = seg.startMs
    // Fin: el del segmento si es valido; si no, hasta el siguiente; si no, +2.5s.
    let end = seg.endMs
    if (end <= start) {
      const next = segs[i + 1]
      end = next && next.startMs > start ? next.startMs : start + 2500
    }
    const speaker = opts.incluirHablantes ? `${seg.speaker}: ` : ''
    cues.push(String(i + 1))
    cues.push(`${formatSrtTimecode(start)} --> ${formatSrtTimecode(end)}`)
    cues.push(`${speaker}${seg.text}`)
    cues.push('')
  })
  return cues.join('\n')
}
