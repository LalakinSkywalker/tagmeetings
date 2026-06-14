import 'server-only'

// =============================================================================
// extract-text — extracción de texto de PDF / DOCX / texto plano
// =============================================================================
// Para fuentes no-audio (documentos) extraemos su texto server-side y lo
// sumamos al análisis combinado. Imports DINÁMICOS (unpdf, mammoth) para no
// inflar el bundle de rutas que no procesan documentos (cold start serverless).
//   - PDF  → unpdf (pdf.js sin binarios nativos, serverless-friendly)
//   - DOCX → mammoth (extractRawText, JS puro)
//   - txt/md → decode utf-8
// =============================================================================

export type TipoDocumento = 'pdf' | 'doc' | 'texto'

export interface ExtractResult {
  texto: string
  error?: string
}

// Cap de chars para no reventar el contexto del LLM con un PDF gigante.
const MAX_TEXTO_CHARS = 200_000

/**
 * Limpia control chars (charCodeAt, conserva \n y \t — NUNCA regex de clase de
 * control chars, regla feedback_regex_control_chars_unicode_escape), colapsa
 * espacios y aplica el cap.
 */
function limpiarTexto(raw: string): string {
  const cleaned = Array.from(raw)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c === 9 || c === 10 || (c >= 32 && c !== 127)
    })
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.slice(0, MAX_TEXTO_CHARS)
}

/** Deduce el tipo de documento desde el mime / nombre de archivo. */
export function tipoDocumentoDesde(mime: string, nombre: string): TipoDocumento | null {
  const m = (mime || '').toLowerCase()
  const n = (nombre || '').toLowerCase()
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    m === 'application/msword' ||
    n.endsWith('.docx') ||
    n.endsWith('.doc')
  ) {
    return 'doc'
  }
  if (m.startsWith('text/') || n.endsWith('.txt') || n.endsWith('.md')) return 'texto'
  return null
}

/**
 * Extrae el texto de un documento ya descargado (bytes). Best-effort: si la
 * librería falla, devuelve { texto: '', error } para que el caller marque la
 * fuente en error sin tumbar el resto del análisis combinado.
 */
export async function extraerTextoDocumento(
  bytes: ArrayBuffer,
  tipo: TipoDocumento,
  nombre: string,
): Promise<ExtractResult> {
  try {
    if (tipo === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(bytes))
      const res = await extractText(pdf, { mergePages: true })
      const text = Array.isArray(res.text) ? res.text.join('\n') : res.text
      const limpio = limpiarTexto(text ?? '')
      if (limpio.length === 0) {
        return { texto: '', error: `El PDF "${nombre}" no contiene texto extraíble (¿es escaneado/imagen?).` }
      }
      return { texto: limpio }
    }

    if (tipo === 'doc') {
      const mammoth = (await import('mammoth')).default ?? (await import('mammoth'))
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
      const limpio = limpiarTexto(value ?? '')
      if (limpio.length === 0) {
        return { texto: '', error: `El documento "${nombre}" no contiene texto extraíble.` }
      }
      return { texto: limpio }
    }

    // texto plano
    const decoder = new TextDecoder('utf-8')
    const limpio = limpiarTexto(decoder.decode(bytes))
    if (limpio.length === 0) {
      return { texto: '', error: `El archivo "${nombre}" está vacío.` }
    }
    return { texto: limpio }
  } catch (err) {
    return {
      texto: '',
      error: `No se pudo extraer texto de "${nombre}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
