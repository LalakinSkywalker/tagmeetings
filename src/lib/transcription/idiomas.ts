// =============================================================================
// idiomas — fuente UNICA de los idiomas que el motor cubre (Fase 7)
// =============================================================================
// Antes esta lista vivia incrustada en `opciones-captura.tsx` (client). Se
// extrajo aqui (server-safe, sin 'use client') para que la usen, sin duplicar:
//   - el selector de idioma de captura (transcripcion)
//   - el selector de "traducir a" de Ajustes y de captura
//   - la validacion server-side de los defaults del usuario
//
// Verificados contra la doc oficial de Deepgram Nova-3 (2026). NO listamos
// idiomas que el motor no cubra (regla "no mentir", decision de producto
// 2026-05-30). El LLM de traduccion puede traducir entre cualquiera de estos.
// =============================================================================

export interface IdiomaBase {
  value: string
  label: string
}

/** Idiomas base (nombre limpio). Espanol primero; el resto por frecuencia. */
const IDIOMAS_BASE: IdiomaBase[] = [
  { value: 'es-MX', label: 'Español' },
  { value: 'en', label: 'Inglés' },
  { value: 'pt', label: 'Portugués' },
  { value: 'fr', label: 'Francés' },
  { value: 'de', label: 'Alemán' },
  { value: 'it', label: 'Italiano' },
  { value: 'nl', label: 'Neerlandés (holandés)' },
  { value: 'ru', label: 'Ruso' },
  { value: 'ja', label: 'Japonés' },
  { value: 'zh', label: 'Chino (mandarín)' },
  { value: 'ko', label: 'Coreano' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Árabe' },
  { value: 'fa', label: 'Persa (farsi)' },
  { value: 'tr', label: 'Turco' },
  { value: 'pl', label: 'Polaco' },
  { value: 'uk', label: 'Ucraniano' },
  { value: 'cs', label: 'Checo' },
  { value: 'ro', label: 'Rumano' },
  { value: 'el', label: 'Griego' },
  { value: 'sv', label: 'Sueco' },
  { value: 'da', label: 'Danés' },
  { value: 'no', label: 'Noruego' },
  { value: 'fi', label: 'Finés' },
  { value: 'hu', label: 'Húngaro' },
  { value: 'id', label: 'Indonesio' },
  { value: 'ms', label: 'Malayo' },
  { value: 'th', label: 'Tailandés' },
  { value: 'vi', label: 'Vietnamita' },
  { value: 'he', label: 'Hebreo' },
  { value: 'ca', label: 'Catalán' },
  { value: 'bn', label: 'Bengalí' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'ur', label: 'Urdu' },
]

/** Los 10 que Deepgram auto-detecta en modo multi (se marcan con badge "auto"). */
export const IDIOMAS_AUTODETECTA = new Set([
  'es', 'en', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'ja', 'hi',
])

/**
 * Opciones del selector de IDIOMA DE TRANSCRIPCION (captura). Incluye "Detectar
 * automaticamente" y marca el espanol como recomendado.
 */
export const IDIOMA_TRANSCRIPCION_OPCIONES: IdiomaBase[] = [
  { value: 'es-MX', label: 'Español (recomendado)' },
  { value: 'auto', label: 'Detectar automáticamente (10 idiomas)' },
  ...IDIOMAS_BASE.filter((i) => i.value !== 'es-MX'),
]

/**
 * Opciones del selector de TRADUCCION DESTINO (Ajustes / override por sesion).
 * Sin "auto"; el "No traducir" se modela como `null` aparte (no como opcion de
 * esta lista). Espanol primero (caso comun, default).
 */
export const IDIOMA_TRADUCCION_OPCIONES: IdiomaBase[] = IDIOMAS_BASE

/** Validadores server-side (anti dato basura en los defaults del usuario). */
export const IDIOMAS_TRANSCRIPCION_VALIDOS: ReadonlySet<string> = new Set(
  IDIOMA_TRANSCRIPCION_OPCIONES.map((o) => o.value),
)
export const IDIOMAS_TRADUCCION_VALIDOS: ReadonlySet<string> = new Set(
  IDIOMA_TRADUCCION_OPCIONES.map((o) => o.value),
)

/** Etiqueta legible de un codigo de idioma. `null` => "No traducir". */
export function idiomaLabel(value: string | null | undefined): string {
  if (!value) return 'No traducir'
  if (value === 'auto') return 'Detectar automáticamente'
  const found = IDIOMAS_BASE.find((i) => i.value === value)
  return found?.label ?? value
}
