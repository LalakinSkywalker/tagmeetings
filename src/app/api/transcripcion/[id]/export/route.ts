// =============================================================================
// PRP-TT-V2 Fase 6 — Export de documentos (analisis / transcripcion / paquete)
// =============================================================================
// Genera el archivo del lado SERVIDOR y lo sirve con Content-Disposition, asi el
// navegador (incluido iOS) siempre lo descarga con el nombre limpio. Valida
// sesion + RLS. El audio suelto tiene su propio route (/audio); aqui el paquete
// baja el audio internamente desde R2.
//
// Query:
//   ?content=analisis|transcripcion|paquete
//   &format=txt|md|srt|docx|pdf   (para analisis/transcripcion)
//   &ts=1|0  &sp=1|0              (transcripcion: timestamps / hablantes)
// =============================================================================

import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getStorageAdapter, resolveTemplateAsync } from '@/lib/transcription'
import { buildExportData } from '@/lib/export/export-data'
import {
  generateDocServer,
  generatePaqueteServer,
  type DocContent,
} from '@/lib/export/server-generate'
import { resolveBrandingForPdf } from '@/lib/export/branding'
import { tituloParaArchivo, type ExportFormat, type TranscripcionOpts } from '@/lib/export/format'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FORMATS: ExportFormat[] = ['txt', 'md', 'srt', 'docx', 'pdf']

const SELECT =
  'id, titulo, template_id, raw_text, raw_text_traducido, segments, segments_traducido, analisis, categoria, duracion_ms, idioma, idioma_detectado, traducido_a, cost_usd_total, created_at, completed_at, speaker_names, modo_analisis, audio_path'

function contentDisposition(filename: string): string {
  // ASCII fallback + UTF-8 real para acentos/espacios.
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const url = _req.nextUrl
  const content = url.searchParams.get('content') ?? 'analisis'
  const formatParam = url.searchParams.get('format') ?? 'pdf'
  const opts: TranscripcionOpts = {
    incluirTimestamps: url.searchParams.get('ts') !== '0',
    incluirHablantes: url.searchParams.get('sp') !== '0',
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new NextResponse('No autenticado', { status: 401 })

  const { data, error } = await supabase.from('transcripciones').select(SELECT).eq('id', id).single()
  if (error || !data) return new NextResponse('No encontrado', { status: 404 })

  const plantilla = await resolveTemplateAsync(supabase, data.template_id, user.id)
  const exportData = buildExportData(data, plantilla?.name ?? data.template_id)
  // Marca del usuario (Fase 7): color + logo en el PDF. undefined → branding default.
  const branding = await resolveBrandingForPdf(supabase, user.id)

  try {
    let body: Uint8Array | string
    let contentType: string
    let filename: string

    if (content === 'paquete') {
      let audio: { bytes: Uint8Array; filename: string } | null = null
      if (data.audio_path) {
        try {
          const storage = getStorageAdapter()
          const signed = await storage.getSignedDownloadUrl(data.audio_path, { expiresInSec: 900 })
          const res = await fetch(signed)
          if (res.ok) {
            const ext =
              (data.audio_path.split('.').pop() ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') ||
              'audio'
            audio = {
              bytes: new Uint8Array(await res.arrayBuffer()),
              filename: `${tituloParaArchivo(data.titulo)} - Audio.${ext}`,
            }
          }
        } catch {
          audio = null // el paquete sigue util sin el audio
        }
      }
      ;({ body, contentType, filename } = await generatePaqueteServer(exportData, opts, audio, branding))
    } else {
      if (content !== 'analisis' && content !== 'transcripcion') {
        return new NextResponse('content invalido', { status: 400 })
      }
      const format = (FORMATS.includes(formatParam as ExportFormat) ? formatParam : 'pdf') as ExportFormat
      ;({ body, contentType, filename } = await generateDocServer(
        exportData,
        content as DocContent,
        format,
        opts,
        branding,
      ))
    }

    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Content-Disposition', contentDisposition(filename))
    headers.set('Cache-Control', 'private, no-store')
    // Uint8Array es BodyInit valido en runtime; el cast evita el mismatch del
    // generico Uint8Array<ArrayBufferLike> con los tipos del DOM (TS 5.7+).
    return new NextResponse(body as BodyInit, { status: 200, headers })
  } catch (err) {
    return new NextResponse(
      `No se pudo generar el archivo: ${err instanceof Error ? err.message : 'error'}`,
      { status: 500 },
    )
  }
}
