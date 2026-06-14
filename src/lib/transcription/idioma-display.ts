// =============================================================================
// Nombres legibles de idiomas (isomorfico: client + server + export)
// =============================================================================
// A diferencia de idioma.ts (server-only, logica de traduccion), este modulo es
// puro y se puede usar en el cliente y en el motor de export. Unica fuente de
// verdad del mapeo codigo BCP-47 -> nombre en espanol.
// =============================================================================

/** Nombre legible de un codigo de idioma BCP-47. */
export const LANG_NOMBRES: Record<string, string> = {
  es: 'Español',
  en: 'Inglés',
  pt: 'Portugués',
  fr: 'Francés',
  de: 'Alemán',
  it: 'Italiano',
  ru: 'Ruso',
  ja: 'Japonés',
  nl: 'Neerlandés',
  hi: 'Hindi',
  zh: 'Chino',
  ko: 'Coreano',
}

/** Traduce un codigo de idioma a su nombre legible; cae al codigo si no se conoce. */
export function nombreIdioma(code: string | null | undefined): string | null {
  if (!code) return null
  const base = code.toLowerCase().split('-')[0] ?? code.toLowerCase()
  return LANG_NOMBRES[base] ?? code
}
