import 'server-only'
import { headers } from 'next/headers'

// =============================================================================
// callback-url — construye la URL HTTPS del callback de Deepgram
// =============================================================================
// Compartido por el flujo single-audio (iniciarTranscripcion) y multi-fuente
// (iniciarTranscripcionMultifuente). Resolución del host:
//   1. DEEPGRAM_WEBHOOK_BASE_URL (override; tunnel dev o preview Vercel).
//   2. Headers de la request (x-forwarded-host + x-forwarded-proto) — canónico
//      en Vercel/Next: refleja el host real (prod, preview, dominio custom).
//   3. NEXT_PUBLIC_SITE_URL (fallback sin headers, ej. cron).
// Deepgram rechaza HTTP: valida HTTPS.
// =============================================================================

export async function buildDeepgramCallbackUrl(
  transcripcionId: string,
  secret: string,
  fuenteId?: string,
): Promise<string> {
  let base = process.env.DEEPGRAM_WEBHOOK_BASE_URL

  if (!base) {
    try {
      const h = await headers()
      const host = h.get('x-forwarded-host') ?? h.get('host')
      const proto = h.get('x-forwarded-proto') ?? 'https'
      if (host) base = `${proto}://${host}`
    } catch {
      // fuera de request context (ej. cron) — siguiente fallback
    }
  }

  if (!base) base = process.env.NEXT_PUBLIC_SITE_URL

  if (!base) {
    throw new Error(
      'buildDeepgramCallbackUrl: no pude resolver el host base (no DEEPGRAM_WEBHOOK_BASE_URL, no request headers, no NEXT_PUBLIC_SITE_URL).',
    )
  }
  if (!base.startsWith('https://')) {
    throw new Error(
      `buildDeepgramCallbackUrl: base URL debe ser HTTPS (Deepgram rechaza HTTP). Got: ${base}. Para dev local con flujo async real, usar un tunnel HTTPS (ngrok, cloudflare) y setear DEEPGRAM_WEBHOOK_BASE_URL.`,
    )
  }

  const cleanBase = base.replace(/\/$/, '')
  let url =
    `${cleanBase}/api/webhooks/deepgram` +
    `?id=${encodeURIComponent(transcripcionId)}` +
    `&secret=${encodeURIComponent(secret)}`
  if (fuenteId) url += `&fuente=${encodeURIComponent(fuenteId)}`
  return url
}
