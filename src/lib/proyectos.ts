// =============================================================================
// Constantes de Proyectos (compartidas server + cliente). PRP-TT-V2 Fase 5.
// =============================================================================
// Vive FUERA del archivo de server actions: un archivo 'use server' solo puede
// exportar funciones async, no constantes/objetos. El selector de color de la
// UI (cliente) y la validación del backend usan esta misma paleta.
// =============================================================================

/** Paleta de colores de proyecto (acento estilo carpetas de OS). */
export const COLORES_PROYECTO = [
  '#ff8133', // naranja Bluntag (default)
  '#3b82f6', // azul
  '#22c55e', // verde
  '#a855f7', // morado
  '#ef4444', // rojo
  '#eab308', // ambar
  '#14b8a6', // teal
  '#ec4899', // rosa
] as const

export const COLOR_PROYECTO_DEFAULT = COLORES_PROYECTO[0]
