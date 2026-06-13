import 'server-only'

// =============================================================================
// branding — resuelve la marca del usuario para los PDFs (Fase 7)
// =============================================================================
// Lee user_settings (color + logo). El logo vive en R2 (privado); aquí lo baja
// con una signed URL y lo convierte a data URI (PNG/JPG) para pasarlo a
// @react-pdf como <Image>. Best-effort: si el logo falla, el PDF sale con el
// color y el wordmark (nunca se rompe el export por un logo).
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getStorageAdapter } from '@/lib/transcription'
import type { PdfBranding } from './pdf'

function guessMimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return 'image/png'
}

export async function resolveBrandingForPdf(
  supabase: SupabaseClient,
  userId: string,
): Promise<PdfBranding | undefined> {
  const { data } = await supabase
    .from('user_settings')
    .select('brand_color_primario, brand_logo_path')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return undefined

  const accent = (data.brand_color_primario as string | null) || undefined
  let logoDataUri: string | null = null

  const logoPath = (data.brand_logo_path as string | null) || null
  if (logoPath) {
    try {
      const storage = getStorageAdapter()
      const signed = await storage.getSignedDownloadUrl(logoPath, { expiresInSec: 300 })
      const res = await fetch(signed)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const mime = res.headers.get('content-type') || guessMimeFromPath(logoPath)
        logoDataUri = `data:${mime};base64,${buf.toString('base64')}`
      }
    } catch {
      logoDataUri = null // logo best-effort: nunca rompe el PDF
    }
  }

  if (!accent && !logoDataUri) return undefined
  return { accent, logoDataUri }
}
