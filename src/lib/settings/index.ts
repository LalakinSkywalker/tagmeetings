import 'server-only'

// =============================================================================
// settings — configuracion 1:1 por usuario
// =============================================================================
// Resuelve los DEFAULTS del usuario que alimentan la captura y el branding de
// exports. Regla de oro (config siempre influye el comportamiento real): cada campo aqui DEBE influir el
// comportamiento real. El default se COPIA a la fila de `transcripciones` al
// crear el draft (snapshot por sesion), asi cambiar un default NO altera
// sesiones ya creadas y el pipeline async lee solo de `transcripciones`.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizarModoAnalisis, type ModoAnalisis } from '@/lib/transcription/modo-analisis'

/** Modo de respaldo del audio a Drive antes de liberarlo (Bloque Almacenamiento). */
export type RespaldoModo = 'auto' | 'manual' | 'off'

/** Opciones de retencion del audio permitidas en la UI (dias). NULL = nunca borrar. */
export const RETENCION_OPCIONES_DIAS = [30, 90, 180] as const

function normalizarRespaldoModo(v: unknown): RespaldoModo {
  return v === 'auto' || v === 'manual' ? v : 'off'
}

export interface UserSettings {
  /** Idioma de transcripcion por defecto (Deepgram). Ej 'es-MX' | 'auto' | 'en'. */
  idiomaDefault: string
  /** Idioma destino de traduccion. `null` = NO traducir (analizar en el original). */
  traducirA: string | null
  /** Modo de analisis por defecto del LLM. */
  modoAnalisisDefault: ModoAnalisis
  /** Plantilla por defecto. `null` = primera plantilla disponible. */
  templateIdDefault: string | null
  /** Marca para exports. */
  brandLogoPath: string | null
  brandColorPrimario: string | null
  brandColorSecundario: string | null
  /** Dias antes de liberar el audio de R2 (Bloque Almacenamiento). `null` = nunca borrar. */
  retencionAudioDias: number | null
  /** Modo de respaldo a Drive antes de liberar el audio. */
  respaldoModo: RespaldoModo
  /** Avisar por push antes de liberar el audio. */
  avisoExpiracionActivo: boolean
  /** Dias de anticipacion del aviso "tu audio esta por expirar". */
  avisoExpiracionDias: number
}

/**
 * Defaults cuando el usuario aun NO tiene fila en `user_settings`. Reproducen el
 * comportamiento historico: transcribir en espanol, traducir a espanol, modo
 * rapido, primera plantilla, sin branding propio.
 */
export const SETTINGS_DEFAULTS: UserSettings = {
  idiomaDefault: 'es-MX',
  traducirA: 'es-MX',
  modoAnalisisDefault: 'rapido',
  templateIdDefault: null,
  brandLogoPath: null,
  brandColorPrimario: null,
  brandColorSecundario: null,
  retencionAudioDias: null, // nunca borrar (default conservador)
  respaldoModo: 'off',
  avisoExpiracionActivo: true,
  avisoExpiracionDias: 3,
}

/** Columnas de `user_settings` (sin SELECT *, regla del workspace). */
const SETTINGS_COLUMNS =
  'idioma_default, traducir_a, modo_analisis_default, template_id_default, brand_logo_path, brand_color_primario, brand_color_secundario, retencion_audio_dias, respaldo_modo, aviso_expiracion_activo, aviso_expiracion_dias'

/**
 * Lee la configuracion del usuario. Si no hay fila, devuelve los defaults. Si la
 * fila existe, respeta `traducir_a = null` (eleccion legitima de "no traducir").
 * Acepta cualquier cliente Supabase (user con RLS o service); el `eq(user_id)`
 * es defensivo aunque RLS ya filtre.
 */
export async function resolveUserSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserSettings> {
  const { data } = await supabase
    .from('user_settings')
    .select(SETTINGS_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle()

  if (!data) return { ...SETTINGS_DEFAULTS }

  const row = data as Record<string, unknown>
  return {
    idiomaDefault: (row.idioma_default as string) || SETTINGS_DEFAULTS.idiomaDefault,
    // null legitimo = no traducir; undefined (columna ausente) -> default.
    traducirA: row.traducir_a === undefined ? SETTINGS_DEFAULTS.traducirA : (row.traducir_a as string | null),
    modoAnalisisDefault: normalizarModoAnalisis(row.modo_analisis_default),
    templateIdDefault: (row.template_id_default as string | null) ?? null,
    brandLogoPath: (row.brand_logo_path as string | null) ?? null,
    brandColorPrimario: (row.brand_color_primario as string | null) ?? null,
    brandColorSecundario: (row.brand_color_secundario as string | null) ?? null,
    // null legitimo = nunca borrar; undefined (columna ausente) -> default (tambien null).
    retencionAudioDias:
      row.retencion_audio_dias === undefined
        ? SETTINGS_DEFAULTS.retencionAudioDias
        : (row.retencion_audio_dias as number | null),
    respaldoModo: normalizarRespaldoModo(row.respaldo_modo),
    avisoExpiracionActivo:
      row.aviso_expiracion_activo === undefined
        ? SETTINGS_DEFAULTS.avisoExpiracionActivo
        : Boolean(row.aviso_expiracion_activo),
    avisoExpiracionDias:
      (row.aviso_expiracion_dias as number | null) ?? SETTINGS_DEFAULTS.avisoExpiracionDias,
  }
}
