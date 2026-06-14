// =============================================================================
// Descarga del audio original (proxy mismo-origen)
// =============================================================================
// Sirve el audio de R2 al navegador SIN exponer la URL firmada ni la R2 key, y
// SIN depender del CORS de R2 (el cliente pega contra nuestro propio dominio).
// Valida sesion + RLS (solo el dueno puede bajar su audio), firma la GET de R2
// del lado servidor y transmite el cuerpo con Content-Disposition: attachment.
// Lo usan: descarga directa de audio y el "paquete completo" (.zip) de Fase 6A.
// =============================================================================

import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getStorageAdapter } from '@/lib/transcription'
import { CONTENIDO_LABEL, nombreArchivo, tituloParaArchivo } from '@/lib/export/format'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return new NextResponse('No autenticado', { status: 401 })

  // RLS filtra por user_id: solo devuelve la fila si es del usuario.
  const { data, error } = await supabase
    .from('transcripciones')
    .select('id, titulo, audio_path')
    .eq('id', id)
    .single()
  if (error || !data?.audio_path) {
    return new NextResponse('Audio no disponible', { status: 404 })
  }

  let upstream: Response
  try {
    const storage = getStorageAdapter()
    const signed = await storage.getSignedDownloadUrl(data.audio_path, {
      expiresInSec: 900,
    })
    upstream = await fetch(signed)
  } catch {
    return new NextResponse('No se pudo leer el audio', { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return new NextResponse('No se pudo leer el audio', { status: 502 })
  }

  const ext =
    (data.audio_path.split('.').pop() ?? 'audio').toLowerCase().replace(/[^a-z0-9]/g, '') ||
    'audio'
  const filename = nombreArchivo(data.titulo, CONTENIDO_LABEL.audio, ext)
  // ASCII fallback (filename=) + UTF-8 real (filename*=) para acentos/espacios.
  const asciiName = `${tituloParaArchivo(data.titulo).replace(/[^\x20-\x7E]/g, '_')} - Audio.${ext}`

  const headers = new Headers()
  headers.set('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream')
  headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  )
  const len = upstream.headers.get('content-length')
  if (len) headers.set('Content-Length', len)
  headers.set('Cache-Control', 'private, no-store')

  return new NextResponse(upstream.body, { status: 200, headers })
}
