import 'server-only'

// =============================================================================
// template-options — arma los datos del selector de plantillas
// =============================================================================
// Mezcla las plantillas predefinidas con las plantillas del usuario en un solo
// set de opciones + grupos para OpcionesCaptura. Las predefinidas van PRIMERO
// (en el array) para que el default `templates[0]` siga siendo una predefinida
// sensata; el grupo "Mis plantillas" se muestra al final del selector.
// =============================================================================

import { TEMPLATES_AVAILABLE, TEMPLATE_GRUPOS } from '@/lib/transcription'
import { listarPlantillasUsuario } from '@/actions/plantillas'

export interface TemplateOptionData {
  id: string
  name: string
  description: string
}
export interface TemplateGrupoData {
  label: string
  ids: string[]
}

export interface TemplateSelectorData {
  templates: TemplateOptionData[]
  grupos: TemplateGrupoData[]
  /** Cuántas plantillas custom tiene el usuario (para CTA contextual). */
  customCount: number
}

/**
 * Devuelve las opciones + grupos del selector incluyendo las plantillas del
 * usuario autenticado bajo el grupo "Mis plantillas". Si no tiene ninguna,
 * devuelve solo las predefinidas.
 */
export async function buildTemplateSelectorData(): Promise<TemplateSelectorData> {
  const predefinidas: TemplateOptionData[] = TEMPLATES_AVAILABLE.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))

  const userTemplates = await listarPlantillasUsuario()
  const customOptions: TemplateOptionData[] = userTemplates.map((t) => ({
    id: t.templateId,
    name: t.nombre,
    description: t.descripcion,
  }))

  const templates = [...predefinidas, ...customOptions]
  const grupos: TemplateGrupoData[] =
    customOptions.length > 0
      ? [
          ...TEMPLATE_GRUPOS,
          { label: 'Mis plantillas', ids: customOptions.map((o) => o.id) },
        ]
      : [...TEMPLATE_GRUPOS]

  return { templates, grupos, customCount: customOptions.length }
}
