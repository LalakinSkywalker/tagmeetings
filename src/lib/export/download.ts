// =============================================================================
// PRP-TT-V2 Fase 6 — Disparadores de descarga en el navegador
// =============================================================================

/**
 * Descarga un archivo del propio dominio (ej. /api/.../export). El nombre lo
 * pone el Content-Disposition del servidor, que TODOS los navegadores respetan
 * (incluido iOS, que ignora el download attr de blobs generados en el cliente).
 */
export function downloadUrl(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = '' // usa el filename del Content-Disposition del servidor
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Fuerza la descarga de un Blob ya en memoria (fallback del compartir en desktop). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
}

/** Extrae el filename de un Content-Disposition. Prefiere filename*=UTF-8''
 *  (soporta acentos) y lo decodifica; si no, cae al filename= ASCII. */
export function filenameFromContentDisposition(cd: string | null): string | null {
  if (!cd) return null
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)
  if (star?.[1]) {
    const raw = star[1].trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain?.[1] ? plain[1].trim() : null
}
