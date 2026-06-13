// =============================================================================
// lifecycle-rules — decisiones PURAS del ciclo de vida de los audios.
// =============================================================================
// Sin `server-only` ni dependencias de servidor: aqui viven solo las reglas de
// decision (retencion, ventana de aviso, salvaguarda) para poder testearlas
// aisladas. El motor con BD (`lifecycle.ts`) las consume. Patron del proyecto:
// las funciones puras testeables NO importan server-only (ver combinar.ts).
// =============================================================================

import type { RespaldoModo } from '@/lib/settings'

export const MS_POR_DIA = 86_400_000

/** Paths placeholder que NO son objetos reales en R2 (no liberables aqui). */
export const PATHS_NO_REALES = new Set(['placeholder', 'multifuente'])

/**
 * Dias restantes hasta que el audio expire. `retencionDias = null` => Infinity
 * (nunca borrar). <= 0 => ya toca borrar.
 */
export function diasParaExpirar(opts: {
  baseMs: number
  retencionDias: number | null
  ahoraMs: number
}): number {
  if (opts.retencionDias === null) return Infinity
  const edadDias = (opts.ahoraMs - opts.baseMs) / MS_POR_DIA
  return opts.retencionDias - edadDias
}

export type AccionCiclo = 'skip' | 'esperar' | 'avisar' | 'borrar'

/**
 * Decide la accion para una sesion segun su edad y la politica del usuario.
 * - skip: retencion "nunca".
 * - borrar: ya paso la retencion.
 * - avisar: dentro de la ventana de aviso y aun no se aviso.
 * - esperar: aun no toca nada.
 */
export function decidirAccion(opts: {
  retencionDias: number | null
  baseMs: number
  ahoraMs: number
  avisoActivo: boolean
  avisoDias: number
  avisoYaEnviado: boolean
}): AccionCiclo {
  if (opts.retencionDias === null) return 'skip'
  const restantes = diasParaExpirar({
    baseMs: opts.baseMs,
    retencionDias: opts.retencionDias,
    ahoraMs: opts.ahoraMs,
  })
  if (restantes <= 0) return 'borrar'
  if (opts.avisoActivo && restantes <= opts.avisoDias && !opts.avisoYaEnviado) return 'avisar'
  return 'esperar'
}

export interface PlanBorrado {
  /** El cron puede borrar de inmediato (sin respaldar). */
  borrarDirecto: boolean
  /** El cron debe respaldar primero y solo borrar si el respaldo confirma. */
  respaldarPrimero: boolean
  /** La salvaguarda IMPIDE el borrado (manual sin respaldo previo). */
  bloqueado: boolean
}

/**
 * SALVAGUARDA DURA en forma pura: dado el modo de respaldo y si ya existe un
 * respaldo previo confirmado, decide si se puede borrar.
 * - off: borra directo (el usuario acepto no respaldar).
 * - auto: respalda primero; el borrado depende del exito del respaldo.
 * - manual: solo borra si ya hay respaldo previo; si no, queda bloqueado.
 */
export function planBorrado(opts: {
  respaldoModo: RespaldoModo
  tieneRespaldoPrevio: boolean
}): PlanBorrado {
  if (opts.respaldoModo === 'off') {
    return { borrarDirecto: true, respaldarPrimero: false, bloqueado: false }
  }
  if (opts.respaldoModo === 'auto') {
    return { borrarDirecto: false, respaldarPrimero: true, bloqueado: false }
  }
  // manual
  if (opts.tieneRespaldoPrevio) {
    return { borrarDirecto: true, respaldarPrimero: false, bloqueado: false }
  }
  return { borrarDirecto: false, respaldarPrimero: false, bloqueado: true }
}
