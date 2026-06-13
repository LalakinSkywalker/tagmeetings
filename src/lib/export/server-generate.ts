// =============================================================================
// PRP-TT-V2 Fase 6 — Generacion de archivos en el SERVIDOR
// =============================================================================
// Genera el archivo de export del lado servidor y lo entrega como bytes. El
// route handler lo sirve con Content-Disposition, asi el navegador (incluido
// iOS, que ignora el download attr de blobs client-side) siempre usa el nombre
// limpio. Reusa los mismos builders isomorficos que el cliente.
//
// SOLO server-side: @react-pdf renderToBuffer + docx Packer.toBuffer + jszip
// nodebuffer son pesados y no deben llegar al navegador.
// =============================================================================

import 'server-only'
import { renderToBuffer } from '@react-pdf/renderer'
import { Packer } from 'docx'
import type { ExportData } from './export-data'
import {
  buildAnalisisMarkdown,
  buildAnalisisTxt,
  buildTranscripcionMarkdown,
  buildTranscripcionSrt,
  buildTranscripcionTxt,
  CONTENIDO_LABEL,
  nombreArchivo,
  type ExportFormat,
  type TranscripcionOpts,
} from './format'
import { buildAnalisisDocx, buildTranscripcionDocx } from './docx'
import { buildAnalisisPdfDoc, buildTranscripcionPdfDoc, type PdfBranding } from './pdf'

export type DocContent = 'analisis' | 'transcripcion'

export interface GeneratedExport {
  body: Uint8Array | string
  contentType: string
  filename: string
}

const MIME: Record<ExportFormat, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
}

/** Genera un documento (analisis | transcripcion) en el formato dado. */
export async function generateDocServer(
  data: ExportData,
  content: DocContent,
  format: ExportFormat,
  opts: TranscripcionOpts,
  branding?: PdfBranding,
): Promise<GeneratedExport> {
  const filename = nombreArchivo(data.meta.titulo, CONTENIDO_LABEL[content], format)
  const contentType = MIME[format]

  switch (format) {
    case 'txt':
      return {
        body: content === 'analisis' ? buildAnalisisTxt(data) : buildTranscripcionTxt(data, opts),
        contentType,
        filename,
      }
    case 'md':
      return {
        body:
          content === 'analisis'
            ? buildAnalisisMarkdown(data)
            : buildTranscripcionMarkdown(data, opts),
        contentType,
        filename,
      }
    case 'srt':
      return { body: buildTranscripcionSrt(data, opts), contentType, filename }
    case 'docx': {
      const doc =
        content === 'analisis' ? buildAnalisisDocx(data) : buildTranscripcionDocx(data, opts)
      const buffer = await Packer.toBuffer(doc)
      return { body: new Uint8Array(buffer), contentType, filename }
    }
    case 'pdf': {
      const el =
        content === 'analisis'
          ? buildAnalisisPdfDoc(data, branding)
          : buildTranscripcionPdfDoc(data, opts, branding)
      const buffer = await renderToBuffer(el)
      return { body: new Uint8Array(buffer), contentType, filename }
    }
  }
}

/**
 * Genera el "paquete completo" (.zip): analisis (MD + PDF) + transcripcion (TXT)
 * + audio original si se provee (lo baja el caller de R2).
 */
export async function generatePaqueteServer(
  data: ExportData,
  opts: TranscripcionOpts,
  audio?: { bytes: Uint8Array; filename: string } | null,
  branding?: PdfBranding,
): Promise<GeneratedExport> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const titulo = data.meta.titulo

  if (data.analisis) {
    zip.file(nombreArchivo(titulo, CONTENIDO_LABEL.analisis, 'md'), buildAnalisisMarkdown(data))
    const pdf = await generateDocServer(data, 'analisis', 'pdf', opts, branding)
    zip.file(nombreArchivo(titulo, CONTENIDO_LABEL.analisis, 'pdf'), pdf.body)
  }
  zip.file(
    nombreArchivo(titulo, CONTENIDO_LABEL.transcripcion, 'txt'),
    buildTranscripcionTxt(data, opts),
  )
  if (audio) zip.file(audio.filename, audio.bytes)

  const body = await zip.generateAsync({ type: 'uint8array' })
  return {
    body,
    contentType: 'application/zip',
    filename: nombreArchivo(titulo, CONTENIDO_LABEL.paquete, 'zip'),
  }
}
