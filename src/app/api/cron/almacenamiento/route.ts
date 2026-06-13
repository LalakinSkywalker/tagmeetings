// =============================================================================
// Cron — Ciclo de vida de almacenamiento (Bloque Almacenamiento)
// =============================================================================
// Vercel Cron invoca este endpoint (GET) segun el schedule de `vercel.json`
// (1x/dia de madrugada — el borrado no es urgente). Mismo blindaje que el
// watchdog: CRON_SECRET + comparacion en tiempo constante; sin el header correcto
// → 401; sin CRON_SECRET → 500. Corre con service-role (bypassa RLS) para recorrer
// audios de cualquier usuario; NUNCA devuelve datos crudos, solo un resumen.
// =============================================================================

import 'server-only'
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { correrCicloAlmacenamiento } from '@/lib/storage/lifecycle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Comparacion en tiempo constante (evita timing attacks sobre el secret). */
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
    const result = await correrCicloAlmacenamiento(supabase)
    return NextResponse.json({ ok: true, ...result }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(request: Request) {
  return manejar(request)
}

// POST permitido para disparo manual (mismo secret) — util en QA / on-demand.
export async function POST(request: Request) {
  return manejar(request)
}
