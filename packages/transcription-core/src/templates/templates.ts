import type { AnalysisTemplate } from '../types/index'

// =============================================================================
// Plantillas de analisis de TagMeetings.
// =============================================================================
// Cada plantilla compone: prompt_system + prompt_user_template + output_schema.
// El schema es JSON Schema strict-compatible para OpenAI Structured Outputs:
//   - `additionalProperties: false` en TODOS los object
//   - TODOS los campos en `required` (opcionales se expresan como union nullable
//     `["string", "null"]` — strict mode no acepta "opcional sin tipo nullable")
//   - Sin `$ref` / `$defs` (algunos providers via OpenRouter aun fallan con
//     schemas modernos draft 2020-12 — mantener todo inline draft-07 compatible)
//
// Estos prompts son production-grade pero iterables: se pueden ajustar
// con el uso real. Otro consumidor define sus propias plantillas en su repo.
// =============================================================================

// -----------------------------------------------------------------------------
// Fragmentos reutilizables
// -----------------------------------------------------------------------------

export const BASE_SYSTEM_PROMPT_PROLOGO = `Eres un asistente de notas de reunion profesional.
Procesas transcripciones de audio con diarizacion (Speaker 0, Speaker 1, ...) y
devuelves analisis estructurado en formato JSON.

REGLAS DURAS QUE DEBES CUMPLIR:
- Espanol de Mexico neutro, claro, sin pedanteria ni tecnicismos innecesarios.
- NO inventes datos. Si una seccion no tiene material en la transcripcion, devuelve
  array vacio [] o el string "[NO DOCUMENTADO]".
- Filtra charla casual (saludos, clima, despedidas, "como estas"). Enfocate en
  contenido relevante.
- Referencia speakers como "Speaker 0" / "Speaker 1" — NO inventes nombres reales.
- NO uses markdown wrapping (sin \`\`\`json, sin asteriscos, sin negritas). Solo
  texto plano dentro de los strings JSON.
- NO repitas el resumen en bullets — bullets son punteo distinto al resumen.
- Action items son COMPROMISOS reales mencionados, no sugerencias tuyas.
- Si la transcripcion es ininteligible o muy corta, devuelve campos minimos y
  marca categoria = "ininteligible".`

export const BASE_USER_TEMPLATE = `Plantilla solicitada: {{template_id}}
Duracion: {{duration}} segundos
Idioma: {{language}}

Transcripcion:

{{transcript}}

Procesa segun las instrucciones del sistema y devuelve JSON conforme al schema.`

export const ACTION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['texto', 'due_date', 'owner'],
  properties: {
    texto: { type: 'string' },
    due_date: { type: ['string', 'null'] },
    owner: { type: ['string', 'null'] },
  },
} as const

export const BASE_REQUIRED = ['resumen', 'bullets', 'action_items', 'categoria'] as const
export const BASE_PROPERTIES = {
  resumen: { type: 'string' },
  bullets: { type: 'array', items: { type: 'string' } },
  action_items: { type: 'array', items: ACTION_ITEM_SCHEMA },
  categoria: { type: 'string' },
} as const

// -----------------------------------------------------------------------------
// Plantilla 1: Discovery con prospecto
// -----------------------------------------------------------------------------

// Plantilla FUSIONADA (decision de producto 2026-05-30): "Discovery con prospecto"
// absorbe a la antigua "Presencial con prospecto". Una sola plantilla para todo
// primer contacto con un prospecto — formal (videollamada/llamada) o informal
// (cafe/comida) — porque en la practica un cafe deriva naturalmente en discovery.
// Conserva el id 'discovery' (3 transcripciones ya lo usan; no se rompe el
// re-analisis). Extrae lo de ambas: dolor + presupuesto + alternativas (modo
// diagnostico) Y compromisos + proximo paso + rapport (modo relacion).
export const PLANTILLA_DISCOVERY: AnalysisTemplate = {
  id: 'discovery',
  name: 'Discovery con prospecto',
  description:
    'Primer contacto con un prospecto: café, comida, videollamada o llamada. Extrae dolores, presupuesto, alternativas evaluadas, compromisos, próximo paso y rapport. No importa si fue formal o informal.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "DISCOVERY":
Primer contacto con un prospecto de tu pipeline de ventas. Puede ser formal
(videollamada, llamada) o informal (cafe, comida grabada en celular, con audio
de calidad variable y tono conversacional). El prospecto NO es cliente todavia.
El objetivo del usuario es doble: (1) DIAGNOSTICAR si vale la pena un POC gratis
de 48h, y (2) avanzar la RELACION (dejar compromisos y proximo paso claros). Una
charla de cafe puede derivar naturalmente en discovery — cubre ambas dimensiones
sin forzar: si una seccion no tuvo material, devuelve [].

EXTRAE OBLIGATORIAMENTE:
- pain_points: DOLORES reales que el prospecto VIVE hoy (no opiniones tipo
  "estaria bien si...", no problemas hipoteticos). Cita textual cuando posible.
- budget_signals: senales de presupuesto explicitas ("podemos invertir X")
  o implicitas ("ya pagamos por Y", "el director aprobo Z").
- alternatives_evaluated: que otras soluciones o proveedores ya probo o evaluo
  (incluye "lo intentamos hacer internamente" si aplica).
- buy_signals: momentos donde el prospecto dijo "si pagaria por X" o equivalente.
- compromisos_explicitos: cosas que el prospecto o el usuario dijeron textualmente
  que harian ("te mando el correo manana", "me llamas el lunes"). [] si no hubo.
- proximo_paso: la siguiente accion concreta acordada (o null si no se definio).
- temas_personales_relevantes: hijos, hobbies, viajes mencionados con detalle que
  sirvan para rapport posterior (no chisme). [] si no hubo.
- nivel_interes: caliente | tibio | frio (justifica con la senal mas fuerte).
- categoria: usa "discovery" salvo que sea claramente otro tipo de reunion.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'pain_points',
      'budget_signals',
      'alternatives_evaluated',
      'buy_signals',
      'compromisos_explicitos',
      'proximo_paso',
      'temas_personales_relevantes',
      'nivel_interes',
    ],
    properties: {
      ...BASE_PROPERTIES,
      pain_points: { type: 'array', items: { type: 'string' } },
      budget_signals: { type: 'array', items: { type: 'string' } },
      alternatives_evaluated: { type: 'array', items: { type: 'string' } },
      buy_signals: { type: 'array', items: { type: 'string' } },
      compromisos_explicitos: { type: 'array', items: { type: 'string' } },
      proximo_paso: { type: ['string', 'null'] },
      temas_personales_relevantes: { type: 'array', items: { type: 'string' } },
      nivel_interes: { type: 'string', enum: ['caliente', 'tibio', 'frio'] },
    },
  },
}

// -----------------------------------------------------------------------------
// Plantilla 2: Reunion de seguimiento
// -----------------------------------------------------------------------------

export const PLANTILLA_SEGUIMIENTO: AnalysisTemplate = {
  id: 'seguimiento',
  name: 'Reunión de seguimiento',
  description:
    'Update con cliente o prospecto recurrente. Captura avances desde la reunion anterior, decisiones pendientes y riesgos.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "SEGUIMIENTO":
Reunion de seguimiento con un cliente o prospecto que YA tuvo contacto previo
con el usuario. Generalmente weekly o quincenal.

EXTRAE OBLIGATORIAMENTE:
- avances: progresos concretos desde la reunion anterior (si se mencionan).
- decisiones_pendientes: decisiones que el cliente o el usuario deben tomar pronto,
  con responsable detectado si lo hay.
- riesgos: senales de churn, frustracion del cliente, retrasos, bloqueos serios.
- proximo_milestone: lo siguiente que se acordo trabajar/entregar.
- categoria: usa "seguimiento" salvo que sea claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'avances',
      'decisiones_pendientes',
      'riesgos',
      'proximo_milestone',
    ],
    properties: {
      ...BASE_PROPERTIES,
      avances: { type: 'array', items: { type: 'string' } },
      decisiones_pendientes: { type: 'array', items: { type: 'string' } },
      riesgos: { type: 'array', items: { type: 'string' } },
      proximo_milestone: { type: ['string', 'null'] },
    },
  },
}

// NOTA: la antigua "Plantilla 3: Presencial con prospecto" se FUSIONO en
// PLANTILLA_DISCOVERY (decision de producto 2026-05-30). Ya no existe como plantilla
// separada — su id 'presencial-prospecto' tenia 0 transcripciones. Si en el
// futuro llega un re-analisis con ese id legacy, cae al fallback de discovery.

// -----------------------------------------------------------------------------
// Plantilla: Reunion interna / brainstorm
// -----------------------------------------------------------------------------

export const PLANTILLA_INTERNA: AnalysisTemplate = {
  id: 'interna-brainstorm',
  name: 'Reunión interna / lluvia de ideas',
  description:
    'Sesion propia o con socio. Captura ideas nuevas, decisiones tomadas, y bloqueos identificados.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "INTERNA / BRAINSTORM":
Sesion del usuario solo o con un socio interno. No hay cliente involucrado.
El objetivo es pensar en voz alta, decidir, o destrabar.

EXTRAE OBLIGATORIAMENTE:
- ideas_nuevas: ideas que aparecieron en la sesion, aunque sean rough.
- decisiones_tomadas: decisiones cerradas durante la sesion.
- bloqueos: cosas que se identificaron como bloqueo y requieren investigacion
  externa o esperar input de alguien.
- hipotesis_a_validar: hipotesis sobre negocio/producto que requieren prueba.
- categoria: usa "interna-brainstorm" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'ideas_nuevas',
      'decisiones_tomadas',
      'bloqueos',
      'hipotesis_a_validar',
    ],
    properties: {
      ...BASE_PROPERTIES,
      ideas_nuevas: { type: 'array', items: { type: 'string' } },
      decisiones_tomadas: { type: 'array', items: { type: 'string' } },
      bloqueos: { type: 'array', items: { type: 'string' } },
      hipotesis_a_validar: { type: 'array', items: { type: 'string' } },
    },
  },
}

// -----------------------------------------------------------------------------
// Plantilla 5: Llamada con proveedor
// -----------------------------------------------------------------------------

export const PLANTILLA_PROVEEDOR: AnalysisTemplate = {
  id: 'proveedor',
  name: 'Llamada con proveedor',
  description:
    'Llamada o reunion con proveedor (hosting, herramienta, freelancer). Captura precios, plazos, terminos comerciales.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "PROVEEDOR":
El usuario esta evaluando o renegociando con un proveedor (hosting, SaaS, freelance,
agencia, banco, etc.). El analisis sirve para comparar despues con otros
proveedores.

EXTRAE OBLIGATORIAMENTE:
- precios: precios mencionados con su unidad ("$500 USD mensual", "$50 por hora",
  "$2,000 anual con descuento"). Texto literal de la cifra cuando posible.
- plazos: tiempos de entrega, ramp-up, onboarding, cancelacion.
- terminos_comerciales: politicas de cancelacion, SLA, soporte, garantia,
  exclusividad.
- pros_proveedor: ventajas concretas que el proveedor argumento.
- contras_detectados: red flags o limitaciones que el usuario detecto en la llamada.
- categoria: usa "proveedor" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'precios',
      'plazos',
      'terminos_comerciales',
      'pros_proveedor',
      'contras_detectados',
    ],
    properties: {
      ...BASE_PROPERTIES,
      precios: { type: 'array', items: { type: 'string' } },
      plazos: { type: 'array', items: { type: 'string' } },
      terminos_comerciales: { type: 'array', items: { type: 'string' } },
      pros_proveedor: { type: 'array', items: { type: 'string' } },
      contras_detectados: { type: 'array', items: { type: 'string' } },
    },
  },
}

// -----------------------------------------------------------------------------
// Plantilla 6: Idea suelta / nota de voz
// -----------------------------------------------------------------------------

export const PLANTILLA_IDEA_SUELTA: AnalysisTemplate = {
  id: 'idea-suelta',
  name: 'Idea suelta / nota de voz',
  description:
    'Captura libre sin contraparte (idea en el coche, pensamiento al despertar, etc.). Parsea el pensamiento y extrae lo accionable.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO.replace(
    'transcripciones de audio con diarizacion (Speaker 0, Speaker 1, ...)',
    'notas de voz de un solo hablante',
  )}

CONTEXTO ESPECIFICO DE LA PLANTILLA "IDEA SUELTA":
El usuario dicta una idea suelta a su celular. Solo un speaker. Puede ser idea de
producto, observacion de negocio, recordatorio, queja, insight. No hay
estructura previa.

EXTRAE OBLIGATORIAMENTE:
- idea_central: el pensamiento principal reformulado claro en 1-2 oraciones.
- accionables: acciones concretas que la idea sugiere (puede estar vacio si la
  idea es puramente observacional).
- conecta_con: proyectos, clientes o personas que la idea menciona o sugiere.
  Solo nombres explicitamente mencionados.
- tipo_idea: producto | negocio | personal | recordatorio | insight.
- categoria: usa "idea-suelta" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'idea_central',
      'accionables',
      'conecta_con',
      'tipo_idea',
    ],
    properties: {
      ...BASE_PROPERTIES,
      idea_central: { type: 'string' },
      accionables: { type: 'array', items: { type: 'string' } },
      conecta_con: { type: 'array', items: { type: 'string' } },
      tipo_idea: {
        type: 'string',
        enum: ['producto', 'negocio', 'personal', 'recordatorio', 'insight'],
      },
    },
  },
}

// =============================================================================
// Plantillas GENERICAS multi-tema
// =============================================================================
// Las 6 plantillas anteriores son de venta/negocio (1 hilo, contraparte
// comercial). Estas 4 cubren contenido multi-tema donde NO hay un solo dolor o
// una sola idea: reuniones largas con varios temas, clases, entrevistas y
// medios/noticieros. Resuelven el bug del noticiero "Loreto en Latinus" que
// salio pobre por analizarse con la plantilla idea-suelta (1 hablante, 1 idea).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Plantilla 7: Reunion general (multi-tema)
// -----------------------------------------------------------------------------

export const PLANTILLA_REUNION_GENERAL: AnalysisTemplate = {
  id: 'reunion-general',
  name: 'Reunión general',
  description:
    'Reunión de trabajo con varios temas y participantes (junta de equipo, comité, reunión con cliente recurrente). Captura todos los temas tratados, no solo uno.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "REUNION GENERAL":
Reunion de trabajo multi-tema con uno o varios participantes. A diferencia de un
discovery (un solo hilo comercial), aqui se tratan VARIOS temas distintos en una
misma sesion. NO colapses todo en un solo resumen pobre: cubre cada tema.

EXTRAE OBLIGATORIAMENTE:
- temas_tratados: lista de los temas distintos que se discutieron, cada uno en
  una linea con 1 frase de que se dijo. Cubre TODOS los temas, no solo el primero.
- decisiones: decisiones cerradas durante la reunion (quien decidio que).
- pendientes_por_tema: cosas que quedaron abiertas o sin resolver, idealmente
  ligadas al tema al que pertenecen.
- participantes_mencionados: nombres o roles de personas mencionadas (asistentes
  o terceros relevantes). Solo los mencionados explicitamente.
- categoria: usa "reunion-general" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'temas_tratados',
      'decisiones',
      'pendientes_por_tema',
      'participantes_mencionados',
    ],
    properties: {
      ...BASE_PROPERTIES,
      temas_tratados: { type: 'array', items: { type: 'string' } },
      decisiones: { type: 'array', items: { type: 'string' } },
      pendientes_por_tema: { type: 'array', items: { type: 'string' } },
      participantes_mencionados: { type: 'array', items: { type: 'string' } },
    },
  },
}

// -----------------------------------------------------------------------------
// Plantilla 8: Clase / conferencia / capacitacion
// -----------------------------------------------------------------------------

export const PLANTILLA_CLASE_CONFERENCIA: AnalysisTemplate = {
  id: 'clase-conferencia',
  name: 'Clase / conferencia',
  description:
    'Clase, conferencia, webinar o capacitación. Captura los conceptos clave, ejemplos y tareas en vez de tratarlo como conversación de negocio.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "CLASE / CONFERENCIA":
Contenido educativo: una clase, conferencia, webinar, taller o capacitacion.
Generalmente hay un expositor principal y posiblemente preguntas del publico.
El objetivo del usuario es ESTUDIAR despues, no cerrar una venta.

EXTRAE OBLIGATORIAMENTE:
- tema_principal: el tema central de la sesion en 1 frase.
- conceptos_clave: los conceptos, definiciones o ideas importantes explicados,
  cada uno con una explicacion corta y clara.
- ejemplos_o_casos: ejemplos, casos practicos o analogias que el expositor uso
  para ilustrar (si los hubo).
- tareas_o_recursos: tareas asignadas, lecturas, recursos o herramientas
  recomendadas (si las hubo).
- preguntas_y_respuestas: preguntas del publico con su respuesta resumida (si las hubo).
- categoria: usa "clase-conferencia" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'tema_principal',
      'conceptos_clave',
      'ejemplos_o_casos',
      'tareas_o_recursos',
      'preguntas_y_respuestas',
    ],
    properties: {
      ...BASE_PROPERTIES,
      tema_principal: { type: 'string' },
      conceptos_clave: { type: 'array', items: { type: 'string' } },
      ejemplos_o_casos: { type: 'array', items: { type: 'string' } },
      tareas_o_recursos: { type: 'array', items: { type: 'string' } },
      preguntas_y_respuestas: { type: 'array', items: { type: 'string' } },
    },
  },
}

// -----------------------------------------------------------------------------
// Plantilla 9: Entrevista
// -----------------------------------------------------------------------------

export const PLANTILLA_ENTREVISTA: AnalysisTemplate = {
  id: 'entrevista',
  name: 'Entrevista',
  description:
    'Entrevista de cualquier tipo (a un experto, candidato, cliente, periodística). Captura preguntas, respuestas destacadas y citas textuales.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO}

CONTEXTO ESPECIFICO DE LA PLANTILLA "ENTREVISTA":
Una entrevista: alguien pregunta (entrevistador) y alguien responde (entrevistado).
Puede ser a un experto, candidato a un puesto, cliente, o entrevista periodistica.
El valor esta en las RESPUESTAS y las citas textuales, no en cerrar una venta.

EXTRAE OBLIGATORIAMENTE:
- perfil_entrevistado: quien es el entrevistado y su contexto, en 1 frase (si se
  puede inferir de la conversacion).
- preguntas_clave: las preguntas mas importantes que se hicieron.
- respuestas_destacadas: las respuestas mas relevantes o reveladoras, resumidas.
- citas_textuales: frases textuales memorables o importantes del entrevistado
  (cita literal entre comillas cuando sea posible).
- conclusiones: que se aprende o concluye de la entrevista en su conjunto.
- categoria: usa "entrevista" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'perfil_entrevistado',
      'preguntas_clave',
      'respuestas_destacadas',
      'citas_textuales',
      'conclusiones',
    ],
    properties: {
      ...BASE_PROPERTIES,
      perfil_entrevistado: { type: ['string', 'null'] },
      preguntas_clave: { type: 'array', items: { type: 'string' } },
      respuestas_destacadas: { type: 'array', items: { type: 'string' } },
      citas_textuales: { type: 'array', items: { type: 'string' } },
      conclusiones: { type: 'array', items: { type: 'string' } },
    },
  },
}

// -----------------------------------------------------------------------------
// Plantilla 10: Medios / noticiero / podcast
// -----------------------------------------------------------------------------

export const PLANTILLA_MEDIOS_NOTICIERO: AnalysisTemplate = {
  id: 'medios-noticiero',
  name: 'Medios / noticiero / podcast',
  description:
    'Contenido de medios: noticiero, podcast, programa de radio/TV, panel. Captura los temas cubiertos, datos citados y opiniones — no lo trata como reunión.',
  prompt_system: `${BASE_SYSTEM_PROMPT_PROLOGO.replace(
    'Filtra charla casual (saludos, clima, despedidas, "como estas"). Enfocate en\n  contenido relevante.',
    'Filtra cortinillas, cortes comerciales y muletillas. Enfocate en el contenido\n  informativo. Puede haber varios locutores/invitados y varios temas seguidos.',
  )}

CONTEXTO ESPECIFICO DE LA PLANTILLA "MEDIOS / NOTICIERO / PODCAST":
Contenido de medios: un noticiero, podcast, programa de radio o television, o un
panel de discusion. Hay uno o varios locutores/invitados y normalmente VARIOS
temas o notas seguidas. NO lo trates como una reunion de negocio ni como una
sola idea: cubre cada nota/tema por separado.

EXTRAE OBLIGATORIAMENTE:
- temas_cubiertos: lista de las notas o temas tratados, cada uno con 1-2 frases
  de que se dijo. Cubre TODOS, no solo el primero.
- datos_y_cifras: datos duros, cifras, fechas o estadisticas mencionadas
  (cita el dato con su contexto).
- fuentes_citadas: personas, instituciones, estudios o medios citados como fuente.
- opiniones_o_conclusiones: posturas, opiniones o conclusiones expresadas por los
  locutores/invitados (diferenciandolas de los hechos).
- categoria: usa "medios-noticiero" salvo claramente otra cosa.`,
  prompt_user_template: BASE_USER_TEMPLATE,
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...BASE_REQUIRED,
      'temas_cubiertos',
      'datos_y_cifras',
      'fuentes_citadas',
      'opiniones_o_conclusiones',
    ],
    properties: {
      ...BASE_PROPERTIES,
      temas_cubiertos: { type: 'array', items: { type: 'string' } },
      datos_y_cifras: { type: 'array', items: { type: 'string' } },
      fuentes_citadas: { type: 'array', items: { type: 'string' } },
      opiniones_o_conclusiones: { type: 'array', items: { type: 'string' } },
    },
  },
}

// -----------------------------------------------------------------------------
// Exports agregados
// -----------------------------------------------------------------------------

export const PLANTILLAS_TAGTRANSCRIPTOR: Record<string, AnalysisTemplate> = {
  [PLANTILLA_DISCOVERY.id]: PLANTILLA_DISCOVERY,
  [PLANTILLA_SEGUIMIENTO.id]: PLANTILLA_SEGUIMIENTO,
  [PLANTILLA_INTERNA.id]: PLANTILLA_INTERNA,
  [PLANTILLA_PROVEEDOR.id]: PLANTILLA_PROVEEDOR,
  [PLANTILLA_IDEA_SUELTA.id]: PLANTILLA_IDEA_SUELTA,
  [PLANTILLA_REUNION_GENERAL.id]: PLANTILLA_REUNION_GENERAL,
  [PLANTILLA_CLASE_CONFERENCIA.id]: PLANTILLA_CLASE_CONFERENCIA,
  [PLANTILLA_ENTREVISTA.id]: PLANTILLA_ENTREVISTA,
  [PLANTILLA_MEDIOS_NOTICIERO.id]: PLANTILLA_MEDIOS_NOTICIERO,
}

/**
 * Alias de plantillas legacy → plantilla vigente. Cuando un re-analisis llega
 * con un template_id viejo que ya se fusiono/elimino, lo redirigimos aqui en vez
 * de romper. 'presencial-prospecto' se fusiono en 'discovery' (2026-05-30).
 */
export const PLANTILLA_ALIASES: Record<string, string> = {
  'presencial-prospecto': 'discovery',
}

/**
 * Orden de presentacion en el selector de UI. Las genericas van primero porque
 * son las de uso mas amplio; las de venta/negocio van
 * despues. El campo `grupo` se usa para agrupar visualmente (optgroup).
 */
export const PLANTILLAS_TAGTRANSCRIPTOR_LIST: AnalysisTemplate[] = [
  PLANTILLA_REUNION_GENERAL,
  PLANTILLA_CLASE_CONFERENCIA,
  PLANTILLA_ENTREVISTA,
  PLANTILLA_MEDIOS_NOTICIERO,
  PLANTILLA_IDEA_SUELTA,
  PLANTILLA_DISCOVERY,
  PLANTILLA_SEGUIMIENTO,
  PLANTILLA_INTERNA,
  PLANTILLA_PROVEEDOR,
]

/**
 * Agrupacion de plantillas para el selector (mejor guia).
 * Cada grupo tiene un label y los ids que contiene, en orden de presentacion.
 */
export const PLANTILLAS_GRUPOS: Array<{ label: string; ids: string[] }> = [
  {
    label: 'General',
    ids: [
      'reunion-general',
      'clase-conferencia',
      'entrevista',
      'medios-noticiero',
      'idea-suelta',
    ],
  },
  {
    label: 'Ventas y negocio',
    ids: [
      'discovery',
      'seguimiento',
      'interna-brainstorm',
      'proveedor',
    ],
  },
]
