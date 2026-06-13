import { describe, expect, it } from 'vitest'
import {
  compileCustomTemplate,
  normalizePlantillaSpec,
  buildOutputSchema,
  customTemplateToAnalysisTemplate,
  isCustomTemplateId,
  customTemplateUuid,
  CUSTOM_TEMPLATE_PREFIX,
  MAX_CAMPOS,
  PLANTILLA_SPEC_SCHEMA,
  type PlantillaSpec,
} from '../templates/custom-template-builder'

// -----------------------------------------------------------------------------
// Helper: valida el invariante STRICT de OpenAI Structured Outputs recursivo.
//   - additionalProperties === false en cada object
//   - TODA property aparece en `required`
//   - recurse en nested objects y array items objeto
// Si esto pasa, OpenRouter no rechaza el schema con HTTP 400.
// -----------------------------------------------------------------------------
function assertStrictSchema(schema: Record<string, unknown>): void {
  const type = schema.type
  const isObject =
    type === 'object' || (Array.isArray(type) && (type as string[]).includes('object'))
  if (!isObject) return
  expect(schema.additionalProperties).toBe(false)
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = (schema.required ?? []) as string[]
  const propKeys = Object.keys(props)
  for (const key of propKeys) {
    expect(required).toContain(key)
  }
  // required no debe referir keys inexistentes
  for (const r of required) {
    expect(propKeys).toContain(r)
  }
  for (const val of Object.values(props)) {
    if (!val || typeof val !== 'object') continue
    assertStrictSchema(val)
    if (val.type === 'array' && val.items && typeof val.items === 'object') {
      assertStrictSchema(val.items as Record<string, unknown>)
    }
  }
  // sin $ref / $defs (algunos providers via OpenRouter fallan)
  expect(JSON.stringify(schema)).not.toContain('$ref')
  expect(JSON.stringify(schema)).not.toContain('$defs')
}

const SPEC_VALIDA: PlantillaSpec = {
  nombre: 'Sesión de terapia',
  descripcion: 'Notas de una sesión de terapia individual.',
  contexto: 'El usuario es terapeuta y graba sus sesiones para repasar avances.',
  campos: [
    {
      key: 'temas_emocionales',
      label: 'Temas emocionales',
      tipo: 'lista',
      instruccion: 'Temas emocionales que aparecieron en la sesión.',
      opciones: [],
      nullable: false,
    },
    {
      key: 'estado_animo',
      label: 'Estado de ánimo',
      tipo: 'opcion',
      instruccion: 'El estado de ánimo predominante del paciente.',
      opciones: ['positivo', 'neutro', 'negativo'],
      nullable: false,
    },
    {
      key: 'tarea_asignada',
      label: 'Tarea asignada',
      tipo: 'texto',
      instruccion: 'La tarea o ejercicio asignado para la próxima sesión.',
      opciones: [],
      nullable: true,
    },
  ],
}

describe('compileCustomTemplate — schema strict garantizado', () => {
  it('produce un output_schema strict-valido (base + campos)', () => {
    const c = compileCustomTemplate(SPEC_VALIDA)
    assertStrictSchema(c.output_schema)
  })

  it('incluye los 4 campos base + cada campo custom en required y properties', () => {
    const c = compileCustomTemplate(SPEC_VALIDA)
    const props = c.output_schema.properties as Record<string, unknown>
    const required = c.output_schema.required as string[]
    for (const base of ['resumen', 'bullets', 'action_items', 'categoria']) {
      expect(props).toHaveProperty(base)
      expect(required).toContain(base)
    }
    for (const campo of SPEC_VALIDA.campos) {
      expect(props).toHaveProperty(campo.key)
      expect(required).toContain(campo.key)
    }
  })

  it('mapea tipos: lista→array string, opcion→enum, texto nullable→["string","null"]', () => {
    const c = compileCustomTemplate(SPEC_VALIDA)
    const props = c.output_schema.properties as Record<string, Record<string, unknown>>
    expect(props.temas_emocionales).toEqual({ type: 'array', items: { type: 'string' } })
    expect(props.estado_animo).toEqual({
      type: 'string',
      enum: ['positivo', 'neutro', 'negativo'],
    })
    expect(props.tarea_asignada).toEqual({ type: ['string', 'null'] })
  })

  it('prompt_system menciona el contexto, cada key y categoria', () => {
    const c = compileCustomTemplate(SPEC_VALIDA)
    expect(c.prompt_system).toContain('Sesión de terapia')
    expect(c.prompt_system).toContain('repasar avances')
    expect(c.prompt_system).toContain('temas_emocionales')
    expect(c.prompt_system).toContain('estado_animo')
    expect(c.prompt_system).toContain('tarea_asignada')
    expect(c.prompt_system).toContain('categoria')
    // las opciones del enum se listan en la instruccion
    expect(c.prompt_system).toContain('positivo | neutro | negativo')
  })

  it('reusa el prompt_user_template base (placeholders intactos)', () => {
    const c = compileCustomTemplate(SPEC_VALIDA)
    expect(c.prompt_user_template).toContain('{{transcript}}')
    expect(c.prompt_user_template).toContain('{{language}}')
  })
})

describe('normalizePlantillaSpec — robustez ante specs malformadas', () => {
  it('una spec null/undefined produce template valido solo-base', () => {
    const c = compileCustomTemplate(null)
    assertStrictSchema(c.output_schema)
    expect(c.campos).toEqual([])
    expect(c.nombre).toBe('Plantilla personalizada')
  })

  it('excluye keys reservadas (resumen→resumen_extra)', () => {
    const spec = {
      nombre: 'X',
      descripcion: '',
      contexto: '',
      campos: [
        { key: 'resumen', label: 'r', tipo: 'texto', instruccion: 'x', opciones: [], nullable: false },
      ],
    }
    const norm = normalizePlantillaSpec(spec)
    expect(norm.campos[0]!.key).toBe('resumen_extra')
    assertStrictSchema(buildOutputSchema(norm))
  })

  it('deduplica keys colisionantes', () => {
    const spec = {
      nombre: 'X',
      descripcion: '',
      contexto: '',
      campos: [
        { key: 'tema', label: 'a', tipo: 'lista', instruccion: 'x', opciones: [], nullable: false },
        { key: 'tema', label: 'b', tipo: 'lista', instruccion: 'y', opciones: [], nullable: false },
      ],
    }
    const norm = normalizePlantillaSpec(spec)
    const keys = norm.campos.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('tema')
    expect(keys).toContain('tema_2')
  })

  it('slugifica labels con acentos y espacios a snake_case ascii', () => {
    const spec = {
      nombre: 'X',
      descripcion: '',
      contexto: '',
      campos: [
        { key: 'Cómo está el Ánimo', label: 'l', tipo: 'lista', instruccion: 'x', opciones: [], nullable: false },
      ],
    }
    const norm = normalizePlantillaSpec(spec)
    expect(norm.campos[0]!.key).toBe('como_esta_el_animo')
  })

  it('degrada opcion con <2 opciones a texto', () => {
    const spec = {
      nombre: 'X',
      descripcion: '',
      contexto: '',
      campos: [
        { key: 'sentimiento', label: 's', tipo: 'opcion', instruccion: 'x', opciones: ['solo_uno'], nullable: false },
      ],
    }
    const norm = normalizePlantillaSpec(spec)
    expect(norm.campos[0]!.tipo).toBe('texto')
  })

  it('aplica cap de MAX_CAMPOS', () => {
    const campos = Array.from({ length: MAX_CAMPOS + 5 }, (_, i) => ({
      key: `campo_${i}`,
      label: `c${i}`,
      tipo: 'lista' as const,
      instruccion: 'x',
      opciones: [],
      nullable: false,
    }))
    const norm = normalizePlantillaSpec({ nombre: 'X', descripcion: '', contexto: '', campos })
    expect(norm.campos.length).toBe(MAX_CAMPOS)
  })

  it('tipo invalido cae a lista', () => {
    const spec = {
      nombre: 'X',
      descripcion: '',
      contexto: '',
      campos: [
        { key: 'k', label: 'l', tipo: 'numero_raro', instruccion: 'x', opciones: [], nullable: false },
      ],
    }
    const norm = normalizePlantillaSpec(spec)
    expect(norm.campos[0]!.tipo).toBe('lista')
  })
})

describe('helpers de template_id custom', () => {
  it('isCustomTemplateId / customTemplateUuid', () => {
    const uuid = 'edf1d47c-163b-4a34-a56a-ac3b920aa0c2'
    const tid = `${CUSTOM_TEMPLATE_PREFIX}${uuid}`
    expect(isCustomTemplateId(tid)).toBe(true)
    expect(isCustomTemplateId('discovery')).toBe(false)
    expect(customTemplateUuid(tid)).toBe(uuid)
    expect(customTemplateUuid('discovery')).toBeNull()
  })

  it('customTemplateToAnalysisTemplate mapea a contrato del motor', () => {
    const t = customTemplateToAnalysisTemplate({
      id: 'custom:abc',
      nombre: 'Mi plantilla',
      descripcion: 'desc',
      prompt_system: 'sys',
      prompt_user_template: 'usr',
      output_schema: { type: 'object' },
    })
    expect(t.id).toBe('custom:abc')
    expect(t.name).toBe('Mi plantilla')
    expect(t.description).toBe('desc')
  })
})

describe('PLANTILLA_SPEC_SCHEMA (meta-schema del asesor) es strict-valido', () => {
  it('cumple el invariante strict recursivo', () => {
    assertStrictSchema(PLANTILLA_SPEC_SCHEMA)
  })
})
