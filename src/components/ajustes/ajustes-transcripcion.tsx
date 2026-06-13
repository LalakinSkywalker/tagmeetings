'use client'

// =============================================================================
// AjustesTranscripcion — defaults de transcripción del usuario (Fase 7)
// =============================================================================
// Cada select guarda al instante (optimista) en user_settings vía updateMySettings.
// Estos defaults alimentan la captura (idioma/traducir/modo/plantilla); cada
// sesión puede sobrescribirlos. Patrón mobile-native: label + ⓘ + SelectMenu.
// =============================================================================

import { useState, useTransition } from 'react'
import { SelectMenu, type SelectOption } from '@/components/ui/select-menu'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { updateMySettings, type UpdateSettingsInput } from '@/actions/settings'
import {
  IDIOMA_TRANSCRIPCION_OPCIONES,
  IDIOMA_TRADUCCION_OPCIONES,
  IDIOMAS_AUTODETECTA,
} from '@/lib/transcription/idiomas'
import { MODO_ANALISIS_LABELS, type ModoAnalisis } from '@/lib/transcription/modo-analisis'
import {
  TRADUCIR_NONE,
  type TemplateOption,
} from '@/components/transcriptor/opciones-captura'

/** Sentinela del select de plantilla para "primera disponible" (null). */
const TEMPLATE_AUTO = '__auto__'

interface Props {
  initial: {
    idiomaDefault: string
    traducirA: string | null
    modoAnalisisDefault: ModoAnalisis
    templateIdDefault: string | null
  }
  templates: TemplateOption[]
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const IDIOMA_OPTS: SelectOption[] = IDIOMA_TRANSCRIPCION_OPCIONES.map((o) => ({
  value: o.value,
  label: o.label,
  badge: IDIOMAS_AUTODETECTA.has(o.value) ? 'auto' : undefined,
}))

const TRADUCIR_OPTS: SelectOption[] = [
  { value: TRADUCIR_NONE, label: 'No traducir (idioma original)' },
  ...IDIOMA_TRADUCCION_OPCIONES.map((o) => ({ value: o.value, label: o.label })),
]

const MODO_OPTS: SelectOption[] = [
  { value: 'rapido', label: MODO_ANALISIS_LABELS.rapido },
  { value: 'profundo', label: MODO_ANALISIS_LABELS.profundo },
]

export function AjustesTranscripcion({ initial, templates }: Props) {
  const [idioma, setIdioma] = useState(initial.idiomaDefault)
  const [traducir, setTraducir] = useState<string | null>(initial.traducirA)
  const [modo, setModo] = useState<ModoAnalisis>(initial.modoAnalisisDefault)
  const [templateId, setTemplateId] = useState<string | null>(initial.templateIdDefault)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [, startTransition] = useTransition()

  const templateOpts: SelectOption[] = [
    { value: TEMPLATE_AUTO, label: 'Automática (primera de la lista)' },
    ...templates.map((t) => ({ value: t.id, label: t.name })),
  ]

  // Guarda optimista: el cambio ya se reflejó en el estado; si la action falla,
  // revierte y marca error.
  const save = (patch: UpdateSettingsInput, revert: () => void) => {
    setStatus('saving')
    startTransition(async () => {
      const res = await updateMySettings(patch)
      if (res.ok) {
        setStatus('saved')
      } else {
        revert()
        setStatus('error')
      }
    })
  }

  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            Transcripción por defecto
          </h3>
          <InfoTooltip label="Qué es esto">
            Tus preferencias para cada análisis nuevo. Se aplican automáticamente,
            pero puedes cambiarlas en una sesión puntual al capturar.
          </InfoTooltip>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="space-y-4">
        {/* Idioma del audio */}
        <Field htmlFor="cfg-idioma" label="Idioma del audio" info="El idioma en el que suelen estar tus audios. «Detectar automáticamente» cubre 10 idiomas y mezclas.">
          <SelectMenu
            id="cfg-idioma"
            value={idioma}
            onChange={(v) => {
              const prev = idioma
              setIdioma(v)
              save({ idiomaDefault: v }, () => setIdioma(prev))
            }}
            options={IDIOMA_OPTS}
            searchable
            searchPlaceholder="Buscar idioma…"
            ariaLabel="Idioma del audio por defecto"
          />
        </Field>

        {/* Traducir a */}
        <Field htmlFor="cfg-traducir" label="Traducir a" info="Idioma al que llevamos el resumen y la transcripción. «No traducir» deja el análisis en el idioma original del audio.">
          <SelectMenu
            id="cfg-traducir"
            value={traducir ?? TRADUCIR_NONE}
            onChange={(v) => {
              const next = v === TRADUCIR_NONE ? null : v
              const prev = traducir
              setTraducir(next)
              save({ traducirA: next }, () => setTraducir(prev))
            }}
            options={TRADUCIR_OPTS}
            searchable
            searchPlaceholder="Buscar idioma…"
            ariaLabel="Traducir a por defecto"
          />
        </Field>

        {/* Modo de análisis */}
        <Field htmlFor="cfg-modo" label="Modo de análisis" info="«Rápido» es veloz y económico para el día a día. «Profundo» razona más a fondo: ideal para reuniones densas o importantes.">
          <SelectMenu
            id="cfg-modo"
            value={modo}
            onChange={(v) => {
              const next: ModoAnalisis = v === 'profundo' ? 'profundo' : 'rapido'
              const prev = modo
              setModo(next)
              save({ modoAnalisisDefault: next }, () => setModo(prev))
            }}
            options={MODO_OPTS}
            ariaLabel="Modo de análisis por defecto"
          />
        </Field>

        {/* Plantilla por defecto */}
        <Field htmlFor="cfg-template" label="Plantilla por defecto" info="La plantilla de análisis que se preselecciona al capturar. «Automática» usa la primera de tu lista.">
          <SelectMenu
            id="cfg-template"
            value={templateId ?? TEMPLATE_AUTO}
            onChange={(v) => {
              const next = v === TEMPLATE_AUTO ? null : v
              const prev = templateId
              setTemplateId(next)
              save({ templateIdDefault: next }, () => setTemplateId(prev))
            }}
            options={templateOpts}
            ariaLabel="Plantilla por defecto"
          />
        </Field>
      </div>
    </section>
  )
}

function Field({
  htmlFor,
  label,
  info,
  children,
}: {
  htmlFor: string
  label: string
  info: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-base font-medium text-stone-700 dark:text-stone-200">
          {label}
        </label>
        <InfoTooltip label={label}>{info}</InfoTooltip>
      </div>
      {children}
    </div>
  )
}

function StatusPill({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null
  const map: Record<Exclude<SaveStatus, 'idle'>, { text: string; cls: string }> = {
    saving: { text: 'Guardando…', cls: 'text-stone-400' },
    saved: { text: 'Guardado ✓', cls: 'text-green-600 dark:text-green-400' },
    error: { text: 'No se pudo guardar', cls: 'text-red-600 dark:text-red-400' },
  }
  const { text, cls } = map[status]
  return <span className={`text-xs font-medium ${cls}`}>{text}</span>
}
