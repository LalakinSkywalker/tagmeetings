// =============================================================================
// Modo de analisis — Rapido / Profundo
// =============================================================================
// Eje 1 del control de profundidad: el usuario elige cuanto "piensa" la IA al
// analizar/re-analizar una sesion. Unica fuente de verdad del mapeo modo →
// reasoning_effort, las etiquetas y el default. Lo consumen el server action de
// re-analisis, el pipeline del primer analisis, la UI de captura y la de detalle.
//
// V1 (decision de producto del PRP, seccion 13): el modo Profundo sube el
// reasoning_effort a 'high' pero MANTIENE el modelo default (gpt-5-mini). Escalar
// a un modelo superior solo en Profundo queda diferido hasta que las pruebas
// reales lo justifiquen — protege el consumo de IA en V1.
// Cuando se decida escalar, basta devolver un modelo en `modoToModel`.
// =============================================================================

import type { ReasoningEffort } from '@bluntag/transcription-core'

export type ModoAnalisis = 'rapido' | 'profundo'

export const MODO_ANALISIS_DEFAULT: ModoAnalisis = 'rapido'

/** Etiquetas legibles para la UI (mobile-native: etiqueta corta en el control). */
export const MODO_ANALISIS_LABELS: Record<ModoAnalisis, string> = {
  rapido: 'Rápido',
  profundo: 'Profundo',
}

/** Valida/normaliza un valor arbitrario a un ModoAnalisis (cae al default). */
export function normalizarModoAnalisis(v: unknown): ModoAnalisis {
  return v === 'profundo' ? 'profundo' : 'rapido'
}

/** Mapea el modo al reasoning_effort del LLM. rapido=minimal (actual), profundo=high. */
export function modoToReasoningEffort(modo: ModoAnalisis): ReasoningEffort {
  return modo === 'profundo' ? 'high' : 'minimal'
}

/**
 * Override de modelo por modo. V1: null en ambos (usa el modelo default del
 * engine). Punto unico para escalar el modelo en Profundo el dia que se decida.
 */
export function modoToModel(_modo: ModoAnalisis): string | undefined {
  return undefined
}
