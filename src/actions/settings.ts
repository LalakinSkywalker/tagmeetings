'use server'

// =============================================================================
// Server actions — Configuracion del usuario (Fase 7)
// =============================================================================
// getMySettings(): lee los defaults del usuario autenticado (o defaults base).
// updateMySettings(patch): valida y persiste (upsert) solo los campos provistos.
// Cada campo validado server-side contra la fuente unica de idiomas/modo para no
// guardar datos basura. Revalida ajustes + captura (los defaults la alimentan).
// =============================================================================

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { createClient as createUserSupabaseClient } from '@/lib/supabase/server'
import { getStorageAdapter, deleteStorageObjects } from '@/lib/transcription'
import {
  resolveUserSettings,
  RETENCION_OPCIONES_DIAS,
  type UserSettings,
  type RespaldoModo,
} from '@/lib/settings'
import {
  IDIOMAS_TRANSCRIPCION_VALIDOS,
  IDIOMAS_TRADUCCION_VALIDOS,
} from '@/lib/transcription/idiomas'

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const LOGO_MIMES = new Set(['image/png', 'image/jpeg'])
const LOGO_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

export async function getMySettings(): Promise<UserSettings | null> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  return resolveUserSettings(supabase, user.id)
}

export interface UpdateSettingsInput {
  idiomaDefault?: string
  /** `null` = no traducir. */
  traducirA?: string | null
  modoAnalisisDefault?: 'rapido' | 'profundo'
  /** `null` = primera plantilla disponible. */
  templateIdDefault?: string | null
  brandColorPrimario?: string | null
  brandColorSecundario?: string | null
  /** `null` = nunca borrar; 30/90/180 = dias (Bloque Almacenamiento). */
  retencionAudioDias?: number | null
  respaldoModo?: RespaldoModo
  avisoExpiracionActivo?: boolean
  avisoExpiracionDias?: number
}

export async function updateMySettings(
  input: UpdateSettingsInput,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const patch: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  }

  if (input.idiomaDefault !== undefined) {
    if (!IDIOMAS_TRANSCRIPCION_VALIDOS.has(input.idiomaDefault)) {
      return { ok: false, error: 'Idioma de transcripción no soportado.' }
    }
    patch.idioma_default = input.idiomaDefault
  }

  if (input.traducirA !== undefined) {
    if (input.traducirA !== null && !IDIOMAS_TRADUCCION_VALIDOS.has(input.traducirA)) {
      return { ok: false, error: 'Idioma de traducción no soportado.' }
    }
    patch.traducir_a = input.traducirA // null = no traducir
  }

  if (input.modoAnalisisDefault !== undefined) {
    if (input.modoAnalisisDefault !== 'rapido' && input.modoAnalisisDefault !== 'profundo') {
      return { ok: false, error: 'Modo de análisis inválido.' }
    }
    patch.modo_analisis_default = input.modoAnalisisDefault
  }

  if (input.templateIdDefault !== undefined) {
    patch.template_id_default = input.templateIdDefault // null = primera disponible
  }

  if (input.brandColorPrimario !== undefined) {
    if (input.brandColorPrimario !== null && !HEX_COLOR.test(input.brandColorPrimario)) {
      return { ok: false, error: 'Color primario inválido (usa formato #rrggbb).' }
    }
    patch.brand_color_primario = input.brandColorPrimario
  }

  if (input.brandColorSecundario !== undefined) {
    if (input.brandColorSecundario !== null && !HEX_COLOR.test(input.brandColorSecundario)) {
      return { ok: false, error: 'Color secundario inválido (usa formato #rrggbb).' }
    }
    patch.brand_color_secundario = input.brandColorSecundario
  }

  if (input.retencionAudioDias !== undefined) {
    if (
      input.retencionAudioDias !== null &&
      !(RETENCION_OPCIONES_DIAS as readonly number[]).includes(input.retencionAudioDias)
    ) {
      return { ok: false, error: 'Retención de audio inválida.' }
    }
    patch.retencion_audio_dias = input.retencionAudioDias // null = nunca borrar
  }

  if (input.respaldoModo !== undefined) {
    if (!['auto', 'manual', 'off'].includes(input.respaldoModo)) {
      return { ok: false, error: 'Modo de respaldo inválido.' }
    }
    patch.respaldo_modo = input.respaldoModo
  }

  if (input.avisoExpiracionActivo !== undefined) {
    patch.aviso_expiracion_activo = input.avisoExpiracionActivo
  }

  if (input.avisoExpiracionDias !== undefined) {
    if (
      !Number.isInteger(input.avisoExpiracionDias) ||
      input.avisoExpiracionDias < 1 ||
      input.avisoExpiracionDias > 30
    ) {
      return { ok: false, error: 'Días de aviso inválido (1 a 30).' }
    }
    patch.aviso_expiracion_dias = input.avisoExpiracionDias
  }

  const { error } = await supabase
    .from('user_settings')
    .upsert(patch, { onConflict: 'user_id' })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/ajustes')
  revalidatePath('/dashboard/capturar')
  revalidatePath('/dashboard/grabar')
  return { ok: true }
}

// -----------------------------------------------------------------------------
// Marca (Fase 7): perfil + logo del usuario para el branding de los exports.
// -----------------------------------------------------------------------------

/** Actualiza el nombre visible del perfil (tabla profiles). */
export async function updateMyProfile(input: {
  fullName: string
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const name = input.fullName.trim().slice(0, 80)
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: name || null, updated_at: new Date().toISOString() })
    .eq('id', user.id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/ajustes')
  return { ok: true }
}

/**
 * Devuelve una signed URL para subir el logo del usuario a R2 (PUT directo desde
 * el navegador, igual que el audio). Valida mime (PNG/JPG) y tamaño (<2 MB).
 */
export async function getBrandLogoUploadUrl(input: {
  mime: string
  sizeBytes: number
}): Promise<{ ok: boolean; signedUrl?: string; path?: string; error?: string }> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  if (!LOGO_MIMES.has(input.mime)) return { ok: false, error: 'El logo debe ser PNG o JPG.' }
  if (!(input.sizeBytes > 0) || input.sizeBytes > LOGO_MAX_BYTES) {
    return { ok: false, error: 'El logo debe pesar menos de 2 MB.' }
  }

  const ext = input.mime === 'image/png' ? 'png' : 'jpg'
  const path = `${user.id}/branding/logo-${randomUUID().slice(0, 8)}.${ext}`
  const storage = getStorageAdapter()
  const { url } = await storage.getSignedUploadUrl(path, { expiresInSec: 600 })
  return { ok: true, signedUrl: url, path }
}

/** Persiste el path del logo recién subido + borra el anterior (best-effort). */
export async function saveBrandLogoPath(
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }
  // El path debe pertenecer al usuario (no aceptar rutas ajenas).
  if (!path.startsWith(`${user.id}/branding/`)) {
    return { ok: false, error: 'Ruta inválida.' }
  }

  const { data: prev } = await supabase
    .from('user_settings')
    .select('brand_logo_path')
    .eq('user_id', user.id)
    .maybeSingle()
  const prevPath = (prev?.brand_logo_path as string | null) || null

  const { error } = await supabase
    .from('user_settings')
    .upsert(
      { user_id: user.id, brand_logo_path: path, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  if (error) return { ok: false, error: error.message }

  if (prevPath && prevPath !== path) await deleteStorageObjects([prevPath])
  revalidatePath('/dashboard/ajustes')
  return { ok: true }
}

/** Quita el logo del usuario (limpia el path + borra de R2 best-effort). */
export async function removeBrandLogo(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'No autenticado.' }

  const { data: prev } = await supabase
    .from('user_settings')
    .select('brand_logo_path')
    .eq('user_id', user.id)
    .maybeSingle()
  const prevPath = (prev?.brand_logo_path as string | null) || null

  const { error } = await supabase
    .from('user_settings')
    .update({ brand_logo_path: null, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
  if (error) return { ok: false, error: error.message }

  if (prevPath) await deleteStorageObjects([prevPath])
  revalidatePath('/dashboard/ajustes')
  return { ok: true }
}

// -----------------------------------------------------------------------------
// Almacenamiento (Bloque Almacenamiento): espacio ocupado por los audios en R2.
// -----------------------------------------------------------------------------

/**
 * Suma el peso de los audios del usuario que SIGUEN en R2 (no liberados): tanto
 * los de sesiones single (`transcripciones.audio_size_bytes`) como los de las
 * fuentes de audio/video de sesiones multifuente (`transcripcion_fuentes.size_bytes`,
 * PRP-TT-ALM2). Los documentos (pdf/doc/texto) NO cuentan: este numero significa
 * "lo que se puede liberar". Tolera tamano NULL (cuenta como "desconocido", no
 * rompe). RLS filtra por usuario en ambas tablas.
 */
export async function getStorageUsage(): Promise<{
  bytes: number
  count: number
  desconocidos: number
}> {
  const supabase = await createUserSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { bytes: 0, count: 0, desconocidos: 0 }

  let bytes = 0
  let count = 0
  let desconocidos = 0

  const sumar = (size: unknown) => {
    count++
    if (size == null) desconocidos++
    else bytes += Number(size)
  }
  const esPathReal = (path: string) => path !== '' && path !== 'multifuente' && path !== 'placeholder'

  // 1. Sesiones single con audio real aun en R2.
  const { data: singles } = await supabase
    .from('transcripciones')
    .select('audio_size_bytes, audio_path')
    .is('audio_liberado_en', null)
    .eq('es_multifuente', false)
  for (const r of singles ?? []) {
    if (esPathReal((r.audio_path as string | null) ?? '')) sumar(r.audio_size_bytes)
  }

  // 2. Fuentes de audio/video de sesiones multifuente aun en R2 (no documentos).
  const { data: fuentes } = await supabase
    .from('transcripcion_fuentes')
    .select('size_bytes, audio_path')
    .eq('user_id', user.id)
    .in('tipo', ['audio', 'video'])
    .is('audio_liberado_en', null)
  for (const f of fuentes ?? []) {
    if (esPathReal((f.audio_path as string | null) ?? '')) sumar(f.size_bytes)
  }

  return { bytes, count, desconocidos }
}
