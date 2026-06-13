'use client'

// =============================================================================
// OpcionesCaptura — bloque de opciones previo a grabar/subir (PRP-TT-V2 Fase 2)
// =============================================================================
// Componente presentacional CONTROLADO (el padre tiene el estado). Reune en un
// solo lugar las opciones que comparten la Grabadora y SubirArchivos:
//   - Plantilla de analisis (agrupada + acceso a "Crear nueva con IA").
//   - Idioma del audio (Espanol por defecto + Detectar automaticamente + otros).
//   - Pre-registro ligero de participantes (numero esperado + nombres),
//     colapsable y opcional. NO es biometria — solo para asignar nombres rapido
//     al terminar y avisar si el numero detectado difiere del esperado.
// Los desplegables usan el SelectMenu unificado; las explicaciones largas viven
// en globos InfoTooltip para no ensuciar la interfaz.
// =============================================================================

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { SelectMenu, type SelectOption } from '@/components/ui/select-menu'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  type ModoAnalisis,
  MODO_ANALISIS_LABELS,
  normalizarModoAnalisis,
} from '@/lib/transcription/modo-analisis'
import {
  IDIOMA_TRANSCRIPCION_OPCIONES,
  IDIOMA_TRADUCCION_OPCIONES,
  IDIOMAS_AUTODETECTA,
} from '@/lib/transcription/idiomas'

/** Sentinela del select de traduccion para "no traducir" (null). No usar un
 *  codigo de idioma real ('no' = Noruego colisiona). */
export const TRADUCIR_NONE = '__none__'

/** Defaults de captura resueltos desde la config del usuario (Fase 7). */
export interface CapturaDefaults {
  idioma: string
  traducirA: string | null
  modo: ModoAnalisis
  templateId: string | null
}

export interface TemplateOption {
  id: string
  name: string
  description: string
}

export interface TemplateGrupo {
  label: string
  ids: string[]
}

interface Props {
  templates: TemplateOption[]
  grupos: TemplateGrupo[]
  templateId: string
  onTemplateId: (id: string) => void
  idioma: string
  onIdioma: (v: string) => void
  /** Intención de traducción de la sesión (Fase 7): `null` = no traducir. */
  traducirA: string | null
  onTraducirA: (v: string | null) => void
  numSpeakers: string
  onNumSpeakers: (v: string) => void
  roster: string
  onRoster: (v: string) => void
  /** Modo de análisis (PRP-TT-V2 Fase 5B-C, Eje 1): 'rapido' | 'profundo'. */
  modo: ModoAnalisis
  onModo: (v: ModoAnalisis) => void
  disabled?: boolean
  /** Tamano del control. 'md' (grabadora) o 'sm' (widget). */
  size?: 'sm' | 'md'
}

// Idiomas: fuente unica en `@/lib/transcription/idiomas`. El badge "auto" marca
// los 10 que Deepgram auto-detecta. `es-MX`/`auto` no llevan badge de codigo.
const IDIOMA_SELECT_OPCIONES: SelectOption[] = IDIOMA_TRANSCRIPCION_OPCIONES.map((o) => ({
  value: o.value,
  label: o.label,
  badge: IDIOMAS_AUTODETECTA.has(o.value) ? 'auto' : undefined,
}))

export function OpcionesCaptura({
  templates,
  grupos,
  templateId,
  onTemplateId,
  idioma,
  onIdioma,
  traducirA,
  onTraducirA,
  numSpeakers,
  onNumSpeakers,
  roster,
  onRoster,
  modo,
  onModo,
  disabled = false,
  size = 'md',
}: Props) {
  const router = useRouter()
  const [showParticipantes, setShowParticipantes] = useState(false)

  const modoOptions: SelectOption[] = [
    { value: 'rapido', label: MODO_ANALISIS_LABELS.rapido },
    { value: 'profundo', label: MODO_ANALISIS_LABELS.profundo },
  ]

  // "Traducir a": primera opción "No traducir" (null) + idiomas destino.
  const traducirOptions: SelectOption[] = [
    { value: TRADUCIR_NONE, label: 'No traducir (idioma original)' },
    ...IDIOMA_TRADUCCION_OPCIONES.map((o) => ({ value: o.value, label: o.label })),
  ]

  const padY = size === 'sm' ? 'py-2' : 'py-2.5'
  const textSize = size === 'sm' ? 'text-sm' : 'text-base'
  const fieldClass = `block w-full rounded-md border border-stone-300 bg-white px-3 ${padY} ${textSize} shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100`

  const templateOptions: SelectOption[] = templates.map((t) => ({ value: t.id, label: t.name }))
  const descripcion = templates.find((t) => t.id === templateId)?.description ?? ''

  // Caja del control de Participantes: misma apariencia que el trigger del
  // SelectMenu (Plantilla / Idioma) para que los tres controles se vean igual.
  const triggerClass = `flex w-full items-center justify-between gap-2 rounded-md border border-stone-300 bg-white px-3 ${padY} ${textSize} text-left shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100`

  // Resumen mostrado en la caja cerrada (estilo fila de Ajustes: el valor a la
  // derecha). Prioriza el numero de nombres; si no hay, el numero esperado.
  const nombresRoster = parseRoster(roster)
  const nEsperado = Number.parseInt(numSpeakers, 10)
  const resumenParticipantes =
    nombresRoster.length > 0
      ? `${nombresRoster.length} ${nombresRoster.length === 1 ? 'participante' : 'participantes'}`
      : Number.isFinite(nEsperado) && nEsperado > 0
        ? `${nEsperado} ${nEsperado === 1 ? 'persona' : 'personas'}`
        : ''

  return (
    <div className="space-y-4">
      {/* ---- Plantilla de analisis (agrupada) ---- */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="captura-template" className="text-base font-medium text-stone-700 dark:text-stone-200">
            Plantilla de análisis
          </label>
          {descripcion && <InfoTooltip label="Qué hace esta plantilla">{descripcion}</InfoTooltip>}
        </div>
        <SelectMenu
          id="captura-template"
          value={templateId}
          onChange={onTemplateId}
          options={templateOptions}
          groups={grupos.map((g) => ({ label: g.label, ids: g.ids }))}
          action={{ label: 'Crear nueva con IA', onClick: () => router.push('/dashboard/plantillas/nueva') }}
          disabled={disabled}
          size={size}
          ariaLabel="Plantilla de análisis"
        />
      </div>

      {/* ---- Idioma del audio ---- */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="captura-idioma" className="text-base font-medium text-stone-700 dark:text-stone-200">
            Idioma del audio
          </label>
          <InfoTooltip label="Cómo funciona el idioma">
            Es el idioma en el que está hablado el audio. Por defecto, español.
            «Detectar automáticamente» cubre 10 idiomas (y maneja mezclas); para
            el resto, elígelo a mano en la lista. Qué hacemos con el resultado
            (traducirlo o dejarlo en su idioma) se controla abajo, en «Traducir a».
          </InfoTooltip>
        </div>
        <SelectMenu
          id="captura-idioma"
          value={idioma}
          onChange={onIdioma}
          options={IDIOMA_SELECT_OPCIONES}
          searchable
          searchPlaceholder="Buscar idioma…"
          disabled={disabled}
          size={size}
          ariaLabel="Idioma del audio"
        />
      </div>

      {/* ---- Traducir a (Fase 7: configurable, override por sesion) ---- */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="captura-traducir" className="text-base font-medium text-stone-700 dark:text-stone-200">
            Traducir a
          </label>
          <InfoTooltip label="Qué hace «Traducir a»">
            Idioma al que llevamos el resumen y la transcripción. Por defecto,
            español. Si eliges «No traducir», el análisis se hace en el idioma
            original del audio. Tu preferencia fija se cambia en Ajustes; aquí la
            ajustas solo para esta sesión.
          </InfoTooltip>
        </div>
        <SelectMenu
          id="captura-traducir"
          value={traducirA ?? TRADUCIR_NONE}
          onChange={(v) => onTraducirA(v === TRADUCIR_NONE ? null : v)}
          options={traducirOptions}
          searchable
          searchPlaceholder="Buscar idioma…"
          disabled={disabled}
          size={size}
          ariaLabel="Traducir a"
        />
      </div>

      {/* ---- Modo de analisis (Rapido / Profundo) ---- */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="captura-modo" className="text-base font-medium text-stone-700 dark:text-stone-200">
            Modo de análisis
          </label>
          <InfoTooltip label="Rápido vs Profundo">
            «Rápido» analiza con menos esfuerzo de la IA: es más veloz y económico,
            ideal para el día a día. «Profundo» hace que la IA razone más a fondo:
            tarda un poco más pero saca un resumen y conclusiones más ricas. Útil
            para reuniones importantes o densas. Puedes cambiarlo después al
            re-analizar.
          </InfoTooltip>
        </div>
        <SelectMenu
          id="captura-modo"
          value={modo}
          onChange={(v) => onModo(normalizarModoAnalisis(v))}
          options={modoOptions}
          disabled={disabled}
          size={size}
          ariaLabel="Modo de análisis"
        />
      </div>

      {/* ---- Pre-registro de participantes (mismo patron que Plantilla/Idioma) ---- */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="captura-participantes" className="text-base font-medium text-stone-700 dark:text-stone-200">
            Participantes <span className="font-normal text-stone-400">(opcional)</span>
          </label>
          <InfoTooltip label="Para qué sirve Participantes">
            Anota cuántas personas hablarán y sus nombres. Te ayuda a ponerles
            nombre rápido al terminar y te avisamos si detectamos un número
            distinto. No usa reconocimiento de voz.
          </InfoTooltip>
        </div>

        <button
          type="button"
          id="captura-participantes"
          onClick={() => setShowParticipantes((v) => !v)}
          disabled={disabled}
          aria-expanded={showParticipantes}
          className={triggerClass}
        >
          <span className={`truncate ${resumenParticipantes ? '' : 'text-stone-400'}`}>
            {resumenParticipantes || 'Agregar participantes'}
          </span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className={`size-4 shrink-0 text-stone-400 transition-transform ${showParticipantes ? 'rotate-180' : ''}`}
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {showParticipantes && (
          <div className="mt-2 space-y-3 rounded-md border border-stone-200 px-3 py-3 dark:border-stone-800">
            <div>
              <label
                htmlFor="captura-num-speakers"
                className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300"
              >
                ¿Cuántas personas hablarán?
              </label>
              <input
                id="captura-num-speakers"
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                value={numSpeakers}
                onChange={(e) => onNumSpeakers(e.target.value)}
                placeholder="ej. 3"
                disabled={disabled}
                className={`${fieldClass} max-w-35`}
              />
            </div>

            <div>
              <label
                htmlFor="captura-roster"
                className="mb-1.5 block text-sm font-medium text-stone-600 dark:text-stone-300"
              >
                Nombres (uno por línea o separados por coma)
              </label>
              <textarea
                id="captura-roster"
                value={roster}
                onChange={(e) => onRoster(e.target.value)}
                placeholder={'Ana\nBeto\nCarlos'}
                rows={3}
                disabled={disabled}
                className={`${fieldClass} resize-y`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Parsea el textarea de roster (lineas o comas) a array de nombres limpios. */
export function parseRoster(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 50)
}
