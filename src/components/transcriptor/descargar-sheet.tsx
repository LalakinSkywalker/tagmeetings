'use client'

// =============================================================================
// PRP-TT-V2 Fase 6A/6B — Descargar y Compartir (hoja inferior mobile-native)
// =============================================================================
// Boton en el header del detalle + hoja inferior con:
//   - QUE: Analisis / Transcripcion / Audio original / Paquete completo (.zip)
//   - FORMATO: PDF / Word / Markdown / Texto / Subtitulos (filtrado por contenido)
//   - TOGGLES (transcripcion): marcas de tiempo / nombres de hablantes (con ⓘ)
//
// El archivo se genera en el SERVIDOR (/api/.../export) y se sirve con
// Content-Disposition, asi el nombre sale limpio en cualquier navegador (iOS
// incluido). Descargar = navegar a la URL. Compartir = fetch -> File -> hoja
// nativa. Regla de oro mobile-native: explicaciones en ⓘ, no parrafos grises.
// =============================================================================

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { type ExportFormat, type TranscripcionOpts } from '@/lib/export/format'
import {
  downloadBlob,
  downloadUrl,
  filenameFromContentDisposition,
} from '@/lib/export/download'
import { canShareFiles, shareFile } from '@/lib/export/share'

type Contenido = 'analisis' | 'transcripcion' | 'audio' | 'paquete'

interface Props {
  transcripcionId: string
  titulo: string
  hayAnalisis: boolean
  audioDisponible: boolean
  /** Controlado desde el menú de acciones del header. */
  open: boolean
  onClose: () => void
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  md: 'Markdown',
  txt: 'Texto',
  srt: 'Subtítulos',
}

const FORMATOS_ANALISIS: ExportFormat[] = ['pdf', 'docx', 'md', 'txt']
const FORMATOS_TRANSCRIPCION: ExportFormat[] = ['pdf', 'docx', 'srt', 'md', 'txt']

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 3v12m0-12L8 7m4-4l4 4M6 13v6a2 2 0 002 2h8a2 2 0 002-2v-6"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  info,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  info: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">{label}</span>
        {info}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`tap-scale relative h-6 w-11 shrink-0 rounded-full transition ${
          checked ? 'bg-brand' : 'bg-stone-300 dark:bg-stone-700'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-5.5' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  )
}

export function DescargarSheet({ transcripcionId, titulo, hayAnalisis, audioDisponible, open, onClose }: Props) {
  const [contenido, setContenido] = useState<Contenido>(
    hayAnalisis ? 'analisis' : 'transcripcion',
  )
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [opts, setOpts] = useState<TranscripcionOpts>({
    incluirTimestamps: true,
    incluirHablantes: true,
  })
  const [busyKind, setBusyKind] = useState<null | 'descargar' | 'compartir'>(null)
  const busy = busyKind !== null
  const [error, setError] = useState('')
  const [puedeCompartir, setPuedeCompartir] = useState(false)

  useEffect(() => {
    setPuedeCompartir(canShareFiles())
  }, [])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const formatosDisponibles =
    contenido === 'transcripcion' ? FORMATOS_TRANSCRIPCION : FORMATOS_ANALISIS

  // Si el formato actual no aplica al nuevo contenido, cae al primero valido.
  useEffect(() => {
    if (
      (contenido === 'analisis' || contenido === 'transcripcion') &&
      !formatosDisponibles.includes(format)
    ) {
      setFormat(formatosDisponibles[0]!)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contenido])

  // URL del endpoint del servidor para la seleccion actual.
  function buildUrl(): string {
    const base = `/api/transcripcion/${transcripcionId}`
    if (contenido === 'audio') return `${base}/audio`
    const p = new URLSearchParams({ content: contenido })
    if (contenido !== 'paquete') p.set('format', format)
    p.set('ts', opts.incluirTimestamps ? '1' : '0')
    p.set('sp', opts.incluirHablantes ? '1' : '0')
    return `${base}/export?${p.toString()}`
  }

  const tiles: { key: Contenido; label: string; disabled: boolean }[] = [
    { key: 'analisis', label: 'Análisis', disabled: !hayAnalisis },
    { key: 'transcripcion', label: 'Transcripción', disabled: false },
    { key: 'audio', label: 'Audio original', disabled: !audioDisponible },
    { key: 'paquete', label: 'Paquete completo', disabled: false },
  ]

  const botonLabel =
    contenido === 'audio'
      ? 'Descargar audio'
      : contenido === 'paquete'
        ? 'Descargar paquete (.zip)'
        : `Descargar ${FORMAT_LABEL[format]}`

  function handleDescargar() {
    setError('')
    downloadUrl(buildUrl()) // el navegador descarga con el nombre del servidor
    onClose()
  }

  async function handleCompartir() {
    setBusyKind('compartir')
    setError('')
    try {
      const res = await fetch(buildUrl())
      if (!res.ok) throw new Error('No se pudo generar el archivo.')
      const blob = await res.blob()
      const filename =
        filenameFromContentDisposition(res.headers.get('content-disposition')) ?? 'archivo'
      const shared = await shareFile(blob, filename, {
        title: titulo,
        text: `${titulo} — TagMeetings`,
      })
      if (shared === 'unsupported') downloadBlob(blob, filename) // fallback desktop
      onClose()
    } catch (err) {
      // El usuario canceló la hoja de compartir: no es error.
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'No se pudo compartir.')
      }
    } finally {
      setBusyKind(null)
    }
  }

  const mostrarToggles = contenido === 'transcripcion'

  if (!open) return null

  // Portal al body: el header tiene backdrop-blur, que crea un containing block
  // y atraparia este overlay `fixed` dentro del header. El portal lo saca al
  // body para que la hoja se ancle de verdad a la pantalla.
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Descargar"
              className="fixed inset-x-0 bottom-0 z-50 max-h-[88vh] overflow-y-auto overscroll-contain rounded-t-3xl border-t border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900 sm:inset-x-auto sm:left-1/2 sm:bottom-auto sm:top-1/2 sm:w-104 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
            >
              {/* Asa (móvil) */}
              <div className="flex justify-center pt-2.5 sm:hidden">
                <span className="h-1.5 w-10 rounded-full bg-stone-300 dark:bg-stone-700" />
              </div>

              <div className="px-5 pb-2 pt-3">
                <h3 className="text-lg font-extrabold tracking-tight text-stone-900 dark:text-stone-50">
                  Descargar
                </h3>
              </div>

              <div className="space-y-4 px-5 pb-5">
                {/* Qué descargar */}
                <div>
                  <div className="mb-2 flex items-center gap-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                      Qué descargar
                    </span>
                    <InfoTooltip label="Opciones de descarga">
                      «Análisis» = el resumen, puntos clave y action items. «Transcripción» =
                      el texto literal de lo que se dijo. «Audio original» = el archivo de voz
                      tal cual. «Paquete completo» = un .zip con el análisis (PDF + Markdown),
                      la transcripción{audioDisponible ? ' y el audio' : ''}, todo junto.
                    </InfoTooltip>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {tiles.map((t) => {
                      const active = contenido === t.key
                      return (
                        <button
                          key={t.key}
                          type="button"
                          disabled={t.disabled || busy}
                          onClick={() => setContenido(t.key)}
                          className={`tap-scale flex items-center justify-center gap-1.5 rounded-xl border px-3 py-3 text-sm font-semibold transition disabled:opacity-40 ${
                            active
                              ? 'border-brand bg-brand-soft text-brand dark:bg-brand-softdark'
                              : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800'
                          }`}
                        >
                          {t.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Formato (solo análisis/transcripción) */}
                {(contenido === 'analisis' || contenido === 'transcripcion') && (
                  <div>
                    <span className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                      Formato
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {formatosDisponibles.map((f) => {
                        const active = format === f
                        return (
                          <button
                            key={f}
                            type="button"
                            disabled={busy}
                            onClick={() => setFormat(f)}
                            className={`tap-scale rounded-full border px-3.5 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                              active
                                ? 'border-brand bg-brand text-white'
                                : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800'
                            }`}
                          >
                            {FORMAT_LABEL[f]}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Opciones de transcripción */}
                {mostrarToggles && (
                  <div className="rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-1.5 dark:border-stone-700 dark:bg-stone-800/50">
                    <Toggle
                      checked={opts.incluirTimestamps}
                      onChange={(v) => setOpts((o) => ({ ...o, incluirTimestamps: v }))}
                      label="Marcas de tiempo"
                      info={
                        <InfoTooltip label="Marcas de tiempo">
                          Antepone el minuto y segundo en que empieza cada intervención
                          (ej. 12:30). Útil para ubicar momentos en el audio.
                        </InfoTooltip>
                      }
                    />
                    <Toggle
                      checked={opts.incluirHablantes}
                      onChange={(v) => setOpts((o) => ({ ...o, incluirHablantes: v }))}
                      label="Nombres de hablantes"
                      info={
                        <InfoTooltip label="Nombres de hablantes">
                          Antepone quién habla en cada intervención. Si renombraste a los
                          participantes, salen con su nombre real.
                        </InfoTooltip>
                      }
                    />
                  </div>
                )}

                {error && (
                  <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    {error}
                  </p>
                )}

                <div className="flex gap-2">
                  {puedeCompartir && (
                    <button
                      type="button"
                      onClick={handleCompartir}
                      disabled={busy}
                      className="tap-scale flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-bold text-white transition hover:bg-brand-strong disabled:opacity-60"
                    >
                      {busyKind === 'compartir' ? (
                        'Preparando…'
                      ) : (
                        <>
                          <ShareIcon className="size-4" />
                          Compartir
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDescargar}
                    disabled={busy}
                    className={
                      puedeCompartir
                        ? 'tap-scale flex flex-1 items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white py-3 text-sm font-bold text-stone-700 transition hover:bg-stone-50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800'
                        : 'tap-scale flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-bold text-white transition hover:bg-brand-strong disabled:opacity-60'
                    }
                  >
                    <DownloadIcon className="size-4" />
                    {puedeCompartir ? 'Descargar' : botonLabel}
                  </button>
                </div>
              </div>

              <div className="pb-safe sm:hidden" />
            </div>
    </>,
    document.body,
  )
}
