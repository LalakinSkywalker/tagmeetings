'use client'

// =============================================================================
// AjustesAlmacenamiento — ciclo de vida de los audios en R2 (Bloque Almacenamiento)
// =============================================================================
// Muestra el espacio ocupado y deja configurar: retencion (cuanto se conserva el
// audio), respaldo a Drive antes de liberar, y aviso anticipado. Cada control
// guarda al instante (optimista) en user_settings y MUEVE el motor real del cron
// (config siempre influye el comportamiento real). Solo libera el audio pesado: la transcripcion y el
// analisis viven para siempre. Patron mobile-native: label + valor + globo ⓘ,
// sin parrafos grises (los mensajes de estado son la unica excepcion).
// =============================================================================

import { useState, useTransition } from 'react'
import { SelectMenu, type SelectOption } from '@/components/ui/select-menu'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { updateMySettings, type UpdateSettingsInput } from '@/actions/settings'
import type { RespaldoModo } from '@/lib/settings'

const RETENCION_NUNCA = '__nunca__'

interface Props {
  initial: {
    retencionAudioDias: number | null
    respaldoModo: RespaldoModo
    avisoExpiracionActivo: boolean
    avisoExpiracionDias: number
  }
  usage: { bytes: number; count: number; desconocidos: number }
  driveConnected: boolean
  /** Si la instalacion tiene credenciales de Google: cuando es false, el respaldo a Drive ni se ofrece. */
  driveConfigured: boolean
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const RETENCION_OPTS: SelectOption[] = [
  { value: RETENCION_NUNCA, label: 'Nunca borrar' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
  { value: '180', label: '180 días' },
]

const RESPALDO_OPTS: SelectOption[] = [
  { value: 'off', label: 'Desactivado' },
  { value: 'auto', label: 'Automático' },
  { value: 'manual', label: 'Manual' },
]

const AVISO_OPTS: SelectOption[] = [
  { value: 'off', label: 'No avisar' },
  { value: '1', label: '1 día antes' },
  { value: '3', label: '3 días antes' },
  { value: '7', label: '7 días antes' },
]

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return '< 1 MB'
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function AjustesAlmacenamiento({ initial, usage, driveConnected, driveConfigured }: Props) {
  const [retencion, setRetencion] = useState<number | null>(initial.retencionAudioDias)
  const [respaldo, setRespaldo] = useState<RespaldoModo>(initial.respaldoModo)
  const avisoInicial =
    initial.avisoExpiracionActivo &&
    [1, 3, 7].includes(initial.avisoExpiracionDias)
      ? String(initial.avisoExpiracionDias)
      : initial.avisoExpiracionActivo
        ? '3'
        : 'off'
  const [aviso, setAviso] = useState<string>(avisoInicial)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [, startTransition] = useTransition()

  const save = (patch: UpdateSettingsInput, revert: () => void) => {
    setStatus('saving')
    startTransition(async () => {
      const res = await updateMySettings(patch)
      if (res.ok) setStatus('saved')
      else {
        revert()
        setStatus('error')
      }
    })
  }

  const usageLabel =
    usage.count === 0
      ? 'Sin audios almacenados'
      : `${formatBytes(usage.bytes)} · ${usage.count} ${usage.count === 1 ? 'audio' : 'audios'}` +
        (usage.desconocidos > 0 ? ` (+${usage.desconocidos} sin medir)` : '')

  const respaldoSinDrive = driveConfigured && retencion !== null && respaldo !== 'off' && !driveConnected

  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            Almacenamiento
          </h3>
          <InfoTooltip label="Qué es esto">
            Controla cuánto se conserva el archivo de audio en la nube. Al liberarlo
            se ahorra espacio; tu transcripción y tu análisis quedan para siempre.
          </InfoTooltip>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="space-y-4">
        {/* Espacio en uso (valor, no parrafo) */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium text-stone-700 dark:text-stone-200">Espacio en uso</span>
            <InfoTooltip label="Espacio en uso">
              Suma del peso de tus audios que siguen en la nube. No incluye la
              transcripción ni el análisis (esos pesan muy poco).
            </InfoTooltip>
          </div>
          <span className="shrink-0 text-base font-semibold text-stone-900 tabular-nums dark:text-stone-100">
            {usageLabel}
          </span>
        </div>

        {/* Conservar el audio (retencion) */}
        <Field htmlFor="cfg-retencion" label="Conservar el audio" info="Tiempo que guardamos el audio original antes de liberarlo de la nube. «Nunca borrar» lo conserva indefinidamente. Tu transcripción y análisis no se borran nunca.">
          <SelectMenu
            id="cfg-retencion"
            value={retencion === null ? RETENCION_NUNCA : String(retencion)}
            onChange={(v) => {
              const next = v === RETENCION_NUNCA ? null : Number(v)
              const prev = retencion
              setRetencion(next)
              save({ retencionAudioDias: next }, () => setRetencion(prev))
            }}
            options={RETENCION_OPTS}
            ariaLabel="Conservar el audio"
          />
        </Field>

        {/* Respaldo + aviso solo aplican si hay una retencion activa */}
        {retencion !== null && (
          <>
            {driveConfigured && (
              <Field htmlFor="cfg-respaldo" label="Respaldo a Google Drive" info="«Automático» guarda el audio en tu Drive antes de liberarlo. «Manual» solo libera si ya lo respaldaste tú. «Desactivado» libera sin respaldar. Si está activo, nunca se libera un audio sin respaldo confirmado.">
                <SelectMenu
                  id="cfg-respaldo"
                  value={respaldo}
                  onChange={(v) => {
                    const next = (v === 'auto' || v === 'manual' ? v : 'off') as RespaldoModo
                    const prev = respaldo
                    setRespaldo(next)
                    save({ respaldoModo: next }, () => setRespaldo(prev))
                  }}
                  options={RESPALDO_OPTS}
                  ariaLabel="Respaldo a Google Drive"
                />
                {respaldoSinDrive && (
                  <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    Conecta Google Drive más arriba para que el respaldo funcione.
                  </p>
                )}
              </Field>
            )}

            <Field htmlFor="cfg-aviso" label="Avisarme antes de liberar" info="Te enviamos una notificación push antes de liberar el audio, para que lo descargues o respaldes si lo necesitas. Requiere notificaciones activas.">
              <SelectMenu
                id="cfg-aviso"
                value={aviso}
                onChange={(v) => {
                  const prev = aviso
                  setAviso(v)
                  const patch: UpdateSettingsInput =
                    v === 'off'
                      ? { avisoExpiracionActivo: false }
                      : { avisoExpiracionActivo: true, avisoExpiracionDias: Number(v) }
                  save(patch, () => setAviso(prev))
                }}
                options={AVISO_OPTS}
                ariaLabel="Avisarme antes de liberar"
              />
            </Field>
          </>
        )}
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
