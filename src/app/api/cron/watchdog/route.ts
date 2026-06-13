// =============================================================================
// Cron — Watchdog de jobs async atorados (Fase 10, Robustez)
// =============================================================================
// Vercel Cron invoca este endpoint (GET) según el schedule de `vercel.json`.
// Protegido con CRON_SECRET: Vercel adjunta automáticamente
// `Authorization: Bearer <CRON_SECRET>` cuando esa env var existe. Sin el header
// correcto → 401. Si CRON_SECRET no está configurado → 500 (no dejamos el
// watchdog abierto por accidente). Corre con service-role (bypassa RLS) para
// poder reencaminar jobs de cualquier usuario; NUNCA devuelve datos crudos al
// exterior, solo un resumen de acciones.
// =============================================================================

import 'server-only'
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { correrWatchdog } from '@/lib/transcription/watchdog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Comparación en tiempo constante (evita timing attacks sobre el secret). */
function secretValido(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false
  const esperado = `Bearer ${secret}`
  const a = Buffer.from(authHeader)
  const b = Buffer.from(esperado)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function manejar(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { error: 'CRON_SECRET no configurado (o demasiado corto).' },
      { status: 500 },
    )
  }
  if (!secretValido(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  try {
    const result = await correrWatchdog(supabase)
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(request: Request) {
  return manejar(request)
}

// POST permitido para disparo manual (mismo secret) — útil en QA / on-demand.
export async function POST(request: Request) {
  return manejar(request)
}
