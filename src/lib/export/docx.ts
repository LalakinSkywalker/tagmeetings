// =============================================================================
// PRP-TT-V2 Fase 6 — Generador DOCX (Word) con branding Bluntag
// =============================================================================
// Construye objetos `Document` de la libreria `docx` (isomorfica: corre en el
// navegador y en Node). El empaquetado a Blob/Buffer lo hace el call site
// (`Packer.toBlob` en cliente). No depende de Next ni del DOM.
// =============================================================================

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Paragraph,
  TextRun,
} from 'docx'
import type { ExportData } from './export-data'
import {
  formatCustomFieldKey,
  formatTimestampSmart,
  metaPairs,
  type TranscripcionOpts,
} from './format'

const BRAND = 'FF8133' // naranja Bluntag (sin #)
const GRAY = '78716C' // stone-500
const DARK = '1C1917' // stone-900

function titulo(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text, bold: true, size: 36, color: BRAND })],
  })
}

function metaParagraph(data: ExportData): Paragraph {
  const linea = metaPairs(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ·   ')
  return new Paragraph({
    spacing: { after: 240 },
    children: [new TextRun({ text: linea, size: 18, color: GRAY })],
  })
}

function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 24, color: DARK })],
  })
}

function parrafo(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, size: 22, color: DARK })],
  })
}

function bullet(text: string, runs?: TextRun[]): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60 },
    children: runs ?? [new TextRun({ text, size: 22, color: DARK })],
  })
}

function footer(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 320 },
    border: { top: { style: 'single', size: 4, color: 'E7E5E4', space: 8 } },
    children: [new TextRun({ text, size: 16, color: GRAY, italics: true })],
  })
}

function customFieldParagraphs(val: unknown): Paragraph[] {
  if (Array.isArray(val)) {
    if (val.length === 0) return [parrafo('(vacío)')]
    return val.map((v) => bullet(typeof v === 'string' ? v : JSON.stringify(v)))
  }
  if (typeof val === 'string') return [parrafo(val)]
  if (val === null || val === undefined) return [parrafo('(vacío)')]
  return [parrafo(JSON.stringify(val, null, 2))]
}

function docFrom(children: Paragraph[]): Document {
  return new Document({
    sections: [{ properties: {}, children }],
  })
}

export function buildAnalisisDocx(data: ExportData): Document {
  const { analisis } = data
  const children: Paragraph[] = [titulo(data.meta.titulo), metaParagraph(data)]

  if (!analisis) {
    children.push(parrafo('(Sin análisis disponible)'))
    return docFrom(children)
  }

  if (analisis.resumen) {
    children.push(heading('Resumen'), parrafo(analisis.resumen))
  }
  if (analisis.bullets.length > 0) {
    children.push(heading('Puntos clave'))
    for (const b of analisis.bullets) children.push(bullet(b))
  }
  if (analisis.actionItems.length > 0) {
    children.push(heading('Action items'))
    for (const ai of analisis.actionItems) {
      const runs: TextRun[] = [new TextRun({ text: ai.texto, bold: true, size: 22, color: DARK })]
      const extra: string[] = []
      if (ai.owner) extra.push(`Responsable: ${ai.owner}`)
      if (ai.dueDate) extra.push(`Para: ${ai.dueDate}`)
      if (extra.length) {
        runs.push(new TextRun({ text: `  (${extra.join(' · ')})`, size: 20, color: GRAY, italics: true }))
      }
      children.push(bullet('', runs))
    }
  }
  for (const [key, val] of Object.entries(analisis.customFields)) {
    children.push(heading(formatCustomFieldKey(key)))
    children.push(...customFieldParagraphs(val))
  }
  children.push(
    footer(`Generado por TagMeetings${analisis.modelUsed ? ` · Modelo: ${analisis.modelUsed}` : ''}`),
  )
  return docFrom(children)
}

export function buildTranscripcionDocx(data: ExportData, opts: TranscripcionOpts): Document {
  const children: Paragraph[] = [
    titulo(`${data.meta.titulo} — Transcripción`),
    metaParagraph(data),
  ]

  if (data.segments.length > 0) {
    for (const seg of data.segments) {
      const runs: TextRun[] = []
      if (opts.incluirTimestamps) {
        runs.push(new TextRun({ text: `[${formatTimestampSmart(seg.startMs)}] `, size: 18, color: GRAY }))
      }
      if (opts.incluirHablantes) {
        runs.push(new TextRun({ text: `${seg.speaker}: `, bold: true, size: 22, color: BRAND }))
      }
      runs.push(new TextRun({ text: seg.text, size: 22, color: DARK }))
      children.push(
        new Paragraph({ spacing: { after: 100 }, alignment: AlignmentType.LEFT, children: runs }),
      )
    }
  } else if (data.rawText) {
    children.push(parrafo(data.rawText))
  } else {
    children.push(parrafo('(Sin transcripción disponible)'))
  }
  return docFrom(children)
}
