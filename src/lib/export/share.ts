// =============================================================================
// PRP-TT-V2 Fase 6B — Compartir nativo (Web Share API)
// =============================================================================
// Patron canonico Bluntag (skill whatsapp-pdf-share): el archivo se comparte
// como adjunto REAL via la hoja nativa del SO (WhatsApp, Guardar en Archivos,
// AirDrop, Mail, etc.). SIEMPRE verificar canShare({files}) antes de share().
// En desktop (sin soporte de archivos) el caller cae a descarga directa.
// =============================================================================

/** True si el navegador puede compartir archivos (probe con un File dummy). */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') {
    return false
  }
  try {
    return navigator.canShare({
      files: [new File(['x'], 'probe.txt', { type: 'text/plain' })],
    })
  } catch {
    return false
  }
}

export type ShareResult = 'shared' | 'unsupported'

/**
 * Comparte un Blob como archivo via la hoja nativa. Devuelve 'unsupported' si el
 * navegador no puede compartir archivos (el caller debe caer a descarga). Lanza
 * si el share falla por otra razon; el caller filtra AbortError (cancelacion del
 * usuario) para no mostrarlo como error.
 */
export async function shareFile(
  blob: Blob,
  filename: string,
  opts: { title?: string; text?: string } = {},
): Promise<ShareResult> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function'
  ) {
    return 'unsupported'
  }
  const file = new File([blob], filename, {
    type: blob.type || 'application/octet-stream',
  })
  if (!navigator.canShare({ files: [file] })) return 'unsupported'
  await navigator.share({ files: [file], title: opts.title, text: opts.text })
  return 'shared'
}
