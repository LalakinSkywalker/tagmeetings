// =============================================================================
// custom-template-builder — compilador de plantillas de usuario
// =============================================================================
// El asesor de IA NO emite el JSON Schema crudo (es fragil: olvida
// additionalProperties, deja campos opcionales, mete $ref, etc., y OpenRouter
// rechaza con HTTP 400 en strict mode). En su lugar el asesor emite una
// ESPECIFICACION estructurada de campos (`PlantillaSpec`) — validada ella misma
// con strict mode — y este modulo ENSAMBLA determinísticamente:
//   - un `output_schema` JSON Schema 100% strict-valido (additionalProperties
//     false, todos los campos en required, nullable como union, sin $ref), y
//   - un `prompt_system` consistente con ese schema (mismas keys, mismas reglas).
//
// Garantia: para cualquier spec (incluso una malformada por el LLM), el schema
// resultante SIEMPRE es strict-valido. La robustez vive aqui, no en el prompt.
//
// Reutiliza los building blocks de las plantillas predefinidas (mismo prologo,
// mismos 4 campos base resumen/bullets/action_items/categoria, mismo
// prompt_user_template) para que las plantillas de usuario se comporten
// identico a las de fabrica.
// =============================================================================

import type { AnalysisTemplate } from '../types/index'
import {
  BASE_PROPERTIES,
  BASE_REQUIRED,
  BASE_SYSTEM_PROMPT_PROLOGO,
  BASE_USER_TEMPLATE,
} from './templates'

// -----------------------------------------------------------------------------
// Tipos de la especificacion (lo que produce el asesor)
// -----------------------------------------------------------------------------

/**
 * Tipo de un campo custom:
 *  - `texto`       → string corto (una frase). Puede ser nullable.
 *  - `texto_largo` → string largo (parrafo). Puede ser nullable.
 *  - `lista`       → array de strings (varios items). Nunca null: [] si vacio.
 *  - `opcion`      → string de un conjunto cerrado (enum). Requiere >=2 opciones.
 */
export type CampoTipo = 'texto' | 'texto_largo' | 'lista' | 'opcion'

/** Especificacion de un campo custom propuesto por el asesor. */
export interface CampoSpec {
  /** Identificador snake_case (se sanitiza). Ej. "objeciones_cliente". */
  key: string
  /** Etiqueta legible para humano. Ej. "Objeciones del cliente". */
  label: string
  tipo: CampoTipo
  /** Instruccion de extraccion que va al prompt_system. */
  instruccion: string
  /** Solo para tipo 'opcion': valores permitidos del enum. */
  opciones: string[]
  /** Solo para 'texto'/'texto_largo': true si puede ser null cuando no aplica. */
  nullable: boolean
}

/** Especificacion completa de una plantilla (salida del asesor). */
export interface PlantillaSpec {
  nombre: string
  descripcion: string
  /** Parrafo de contexto ("de que trata esta plantilla / cuando usarla"). */
  contexto: string
  campos: CampoSpec[]
}

/** Resultado de compilar una spec: listo para persistir + usar en el motor. */
export interface CompiledTemplate {
  nombre: string
  descripcion: string
  prompt_system: string
  prompt_user_template: string
  output_schema: Record<string, unknown>
  /** Spec normalizada (keys saneadas, caps aplicados) para guardar y re-editar. */
  campos: CampoSpec[]
}

// -----------------------------------------------------------------------------
// Limites (anti-abuso + mantener prompts/schemas razonables)
// -----------------------------------------------------------------------------

export const MAX_CAMPOS = 12
const MAX_OPCIONES = 12
const MAX_NOMBRE = 80
const MAX_DESCRIPCION = 240
const MAX_CONTEXTO = 1500
const MAX_LABEL = 60
const MAX_INSTRUCCION = 300
const MAX_OPCION_LEN = 48

/** Las 4 keys base estan reservadas — un campo custom no puede pisarlas. */
const RESERVED_KEYS = new Set(['resumen', 'bullets', 'action_items', 'categoria'])

// -----------------------------------------------------------------------------
// Sanitizacion (control chars via charCodeAt, NUNCA regex de clase de control
// chars — regla dura del workspace, feedback_regex_control_chars_unicode_escape)
// -----------------------------------------------------------------------------

function sanitizeText(raw: unknown, max: number, allowNewlines = false): string {
  if (typeof raw !== 'string') return ''
  const cleaned = Array.from(raw)
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      if (allowNewlines && (c === 10 || c === 9)) return true
      return c >= 32 && c !== 127
    })
    .join('')
  const collapsed = allowNewlines
    ? cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : cleaned.replace(/\s+/g, ' ')
  return collapsed.trim().slice(0, max)
}

/**
 * Convierte un texto a key snake_case segura (ascii minuscula + digitos + _).
 * Usa escapes Unicode para quitar acentos (NFD), nunca bytes de control.
 */
function slugifyKey(raw: string): string {
  // NFD descompone acentos en base + marca combinante; el loop de abajo solo
  // acepta a-z/0-9, así que las marcas combinantes (code >= 0x300) se descartan
  // solas — no hace falta un regex de rango combinante (evita bytes invisibles
  // en el fuente, regla feedback_regex_control_chars_unicode_escape).
  const base = raw.normalize('NFD').toLowerCase()
  let out = ''
  for (const ch of base) {
    const c = ch.charCodeAt(0)
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) out += ch
    else if (ch === ' ' || ch === '_' || ch === '-') out += '_'
  }
  out = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!out) out = 'campo'
  if (out.charCodeAt(0) >= 48 && out.charCodeAt(0) <= 57) out = `c_${out}`
  return out.slice(0, 40).replace(/_+$/g, '') || 'campo'
}

const TIPOS_VALIDOS: ReadonlySet<string> = new Set([
  'texto',
  'texto_largo',
  'lista',
  'opcion',
])

// -----------------------------------------------------------------------------
// Normalizacion de la spec
// -----------------------------------------------------------------------------

/**
 * Limpia y valida una spec (potencialmente malformada por el LLM): sanitiza
 * textos, sanea keys a snake_case, deduplica keys, excluye keys reservadas,
 * aplica caps, degrada 'opcion' con <2 opciones a 'texto'. Nunca lanza: devuelve
 * una spec valida (con `campos` posiblemente vacio si todo se descarto).
 */
export function normalizePlantillaSpec(raw: unknown): PlantillaSpec {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const nombre = sanitizeText(obj.nombre, MAX_NOMBRE) || 'Plantilla personalizada'
  const descripcion = sanitizeText(obj.descripcion, MAX_DESCRIPCION)
  const contexto = sanitizeText(obj.contexto, MAX_CONTEXTO, true)

  const rawCampos = Array.isArray(obj.campos) ? obj.campos : []
  const seen = new Set<string>()
  const campos: CampoSpec[] = []

  for (const item of rawCampos) {
    if (campos.length >= MAX_CAMPOS) break
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>

    const label = sanitizeText(c.label, MAX_LABEL) || sanitizeText(c.key, MAX_LABEL)
    let key = slugifyKey(typeof c.key === 'string' && c.key ? c.key : label || 'campo')
    if (RESERVED_KEYS.has(key)) key = `${key}_extra`
    // Deduplicar keys (sufijo numerico).
    if (seen.has(key)) {
      let i = 2
      while (seen.has(`${key}_${i}`)) i++
      key = `${key}_${i}`
    }
    seen.add(key)

    let tipo = (typeof c.tipo === 'string' ? c.tipo : '') as CampoTipo
    if (!TIPOS_VALIDOS.has(tipo)) tipo = 'lista'

    const instruccion = sanitizeText(c.instruccion, MAX_INSTRUCCION) || label

    let opciones: string[] = []
    if (tipo === 'opcion') {
      const rawOpc = Array.isArray(c.opciones) ? c.opciones : []
      const cleaned = rawOpc
        .map((o) => sanitizeText(o, MAX_OPCION_LEN))
        .filter((o) => o.length > 0)
      // Deduplicar (case-insensitive) preservando orden.
      const dedup: string[] = []
      const ls = new Set<string>()
      for (const o of cleaned) {
        const k = o.toLowerCase()
        if (!ls.has(k)) {
          ls.add(k)
          dedup.push(o)
        }
        if (dedup.length >= MAX_OPCIONES) break
      }
      opciones = dedup
      // 'opcion' sin al menos 2 valores no tiene sentido → degradar a texto.
      if (opciones.length < 2) {
        tipo = 'texto'
        opciones = []
      }
    }

    const nullable = tipo === 'texto' || tipo === 'texto_largo' ? Boolean(c.nullable) : false

    campos.push({ key, label: label || key, tipo, instruccion, opciones, nullable })
  }

  return { nombre, descripcion, contexto, campos }
}

// -----------------------------------------------------------------------------
// Compilacion: spec → output_schema strict + prompt_system
// -----------------------------------------------------------------------------

function schemaForCampo(campo: CampoSpec): Record<string, unknown> {
  switch (campo.tipo) {
    case 'lista':
      return { type: 'array', items: { type: 'string' } }
    case 'opcion':
      return { type: 'string', enum: campo.opciones }
    case 'texto':
    case 'texto_largo':
    default:
      return { type: campo.nullable ? ['string', 'null'] : 'string' }
  }
}

function buildPromptSystem(spec: PlantillaSpec): string {
  const lines: string[] = [BASE_SYSTEM_PROMPT_PROLOGO, '']
  lines.push(`CONTEXTO ESPECIFICO DE LA PLANTILLA "${spec.nombre}":`)
  if (spec.contexto) lines.push(spec.contexto)
  lines.push('')
  if (spec.campos.length > 0) {
    lines.push('EXTRAE OBLIGATORIAMENTE:')
    for (const campo of spec.campos) {
      let line = `- ${campo.key}: ${campo.instruccion}`
      if (campo.tipo === 'lista') line += ' (lista de strings; devuelve [] si no hubo).'
      else if (campo.tipo === 'opcion')
        line += ` (un solo valor de: ${campo.opciones.join(' | ')}).`
      else if (campo.nullable) line += ' (string, o null si no aplica).'
      else line += ' (string).'
      lines.push(line)
    }
  }
  lines.push(
    '- categoria: una etiqueta corta (1-3 palabras) que describa el tipo de contenido.',
  )
  return lines.join('\n')
}

/**
 * Ensambla un `output_schema` strict-valido a partir de una spec normalizada:
 * base (resumen/bullets/action_items/categoria) + un campo por cada CampoSpec.
 * Garantia: additionalProperties:false, TODOS los campos en required, nullable
 * como union ["string","null"], sin $ref/$defs — listo para OpenAI strict mode.
 */
export function buildOutputSchema(spec: PlantillaSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...BASE_PROPERTIES }
  const required: string[] = [...BASE_REQUIRED]
  for (const campo of spec.campos) {
    properties[campo.key] = schemaForCampo(campo)
    required.push(campo.key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  }
}

/**
 * Compila una spec (cruda o normalizada) a una plantilla lista para persistir y
 * usar en el motor. Normaliza internamente, así que es seguro pasar la salida
 * directa del LLM.
 */
export function compileCustomTemplate(rawSpec: unknown): CompiledTemplate {
  const spec = normalizePlantillaSpec(rawSpec)
  return {
    nombre: spec.nombre,
    descripcion: spec.descripcion,
    prompt_system: buildPromptSystem(spec),
    prompt_user_template: BASE_USER_TEMPLATE,
    output_schema: buildOutputSchema(spec),
    campos: spec.campos,
  }
}

/**
 * Reconstruye un `AnalysisTemplate` (contrato del motor) desde una plantilla de
 * usuario ya persistida. `id` es el id que se guarda en transcripciones.template_id
 * (ver prefijo CUSTOM_TEMPLATE_PREFIX). El motor solo necesita id, prompt_system,
 * prompt_user_template y output_schema.
 */
export function customTemplateToAnalysisTemplate(input: {
  id: string
  nombre: string
  descripcion?: string | null
  prompt_system: string
  prompt_user_template: string
  output_schema: Record<string, unknown>
}): AnalysisTemplate {
  return {
    id: input.id,
    name: input.nombre,
    description: input.descripcion ?? '',
    prompt_system: input.prompt_system,
    prompt_user_template: input.prompt_user_template,
    output_schema: input.output_schema,
  }
}

/**
 * Prefijo de los template_id custom guardados en transcripciones.template_id.
 * Distingue plantillas de usuario (`custom:<uuid>`) de las predefinidas (`discovery`).
 */
export const CUSTOM_TEMPLATE_PREFIX = 'custom:'

/** True si un template_id apunta a una plantilla de usuario. */
export function isCustomTemplateId(templateId: string): boolean {
  return templateId.startsWith(CUSTOM_TEMPLATE_PREFIX)
}

/** Extrae el uuid de la plantilla de un template_id custom (o null si no lo es). */
export function customTemplateUuid(templateId: string): string | null {
  if (!isCustomTemplateId(templateId)) return null
  const uuid = templateId.slice(CUSTOM_TEMPLATE_PREFIX.length)
  return uuid.length > 0 ? uuid : null
}

// -----------------------------------------------------------------------------
// Meta-schema strict para que el LLM genere una PlantillaSpec
// -----------------------------------------------------------------------------

/**
 * JSON Schema (strict-valido) que el asesor usa para emitir una PlantillaSpec.
 * Todos los campos en required + additionalProperties:false (requisito strict).
 * `opciones` y `nullable` van siempre presentes (el LLM pone [] / false cuando
 * no aplican); la normalizacion luego los ignora segun el tipo.
 */
export const PLANTILLA_SPEC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['nombre', 'descripcion', 'contexto', 'campos'],
  properties: {
    nombre: { type: 'string' },
    descripcion: { type: 'string' },
    contexto: { type: 'string' },
    campos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'tipo', 'instruccion', 'opciones', 'nullable'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          tipo: { type: 'string', enum: ['texto', 'texto_largo', 'lista', 'opcion'] },
          instruccion: { type: 'string' },
          opciones: { type: 'array', items: { type: 'string' } },
          nullable: { type: 'boolean' },
        },
      },
    },
  },
}
