'use client'

// =============================================================================
// PRP-TT-V2 Fase 6C — Hoja "Archivar en Drive" (transparencia + control)
// =============================================================================
// Antes de archivar, el usuario VE a qué cuenta y a qué carpeta va, ELIGE qué
// guardar (análisis / transcripción / audio) y en qué formato, y ve el nombre
// con que quedará cada archivo. Igual de transparente que la descarga.
// El upload es server-side e idempotente (re-archivar reemplaza, no duplica).
// Regla de oro mobile-native: etiquetas+valores en el flujo, explicación en ⓘ.
// =============================================================================

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  nombreArchivo,
  CONTENIDO_LABEL,
  type ExportFormat,
} from '@/lib/export/format'
import { archivarEnDrive, type ArchivarSeleccion } from '@/actions/drive'

interface Props {
  transcripcionId: string
  titulo: string
  hayAnalisis: boolean
  audioDisponible: boolean
  /** Extensión real del audio (de audio_path), para el nombre de preview. */
  audioExt: string
  /** Correo de la cuenta de Drive conectada (null si no se pudo resolver). */
  email: string | null
  /** Nombre del proyecto contenedor, o null si es una sesión suelta. */
  carpetaProyecto: string | null
  archivadoEn: string | null
  driveFolderId: string | null
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
const EXT: Record<ExportFormat, string> = { pdf: 'pdf', docx: 'docx', md: 'md', txt: 'txt', srt: 'srt' }
const FORMATOS_ANALISIS: ExportFormat[] = ['pdf', 'docx', 'md', 'txt']
const FORMATOS_TRANSCRIPCION: ExportFormat[] = ['pdf', 'docx', 'srt', 'md', 'txt']

function DriveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M8 4h8l5 9-4 7H7l-4-7L8 4Z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
      <path d="M8 4l4 9h9M16 4l-7 16M3 13h13" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
    </svg>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      className={`flex size-5 shrink-0 items-center justify-center rounded-md border transition ${
        on
          ? 'border-brand bg-brand text-white'
          : 'border-stone-300 bg-white dark:border-stone-600 dark:bg-stone-800'
      }`}
    >
      {on && (
        <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden="true">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  )
}

/** Fila de un formato seleccionable (chip). */
function FormatChips({
  formatos,
  value,
  onChange,
  disabled,
}: {
  formatos: ExportFormat[]
  value: ExportFormat
  onChange: (f: ExportFormat) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {formatos.map((f) => {
        const active = value === f
        return (
          <button
            key={f}
            type="button"
            disabled={disabled}
            onClick={() => onChange(f)}
            className={`tap-scale rounded-full border px-3 py-1 text-sm font-semibold transition disabled:opacity-50 ${
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
  )
}

function MiniToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="tap-scale flex items-center gap-2"
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          checked ? 'bg-brand' : 'bg-stone-300 dark:bg-stone-700'
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
            checked ? 'left-4.5' : 'left-0.5'
          }`}
        />
      </span>
      <span className="text-sm font-medium text-stone-600 dark:text-stone-300">{label}</span>
    </button>
  )
}

export function ArchivarSheet({
  transcripcionId,
  titulo,
  hayAnalisis,
  audioDisponible,
  audioExt,
  email,
  carpetaProyecto,
  archivadoEn,
  driveFolderId,
  open,
  onClose,
}: Props) {
  const router = useRouter()

  // Selección (default: respaldo completo de lo disponible).
  const [incAnalisis, setIncAnalisis] = useState(hayAnalisis)
  const [fmtAnalisis, setFmtAnalisis] = useState<ExportFormat>('pdf')
  const [incTranscripcion, setIncTranscripcion] = useState(true)
  const [fmtTranscripcion, setFmtTranscripcion] = useState<ExportFormat>('pdf')
  const [tsTranscripcion, setTsTranscripcion] = useState(true)
  const [spTranscripcion, setSpTranscripcion] = useState(true)
  const [incAudio, setIncAudio] = useState(audioDisponible)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resultado, setResultado] = useState<{ folderUrl: string; archivos: string[] } | null>(
    archivadoEn && driveFolderId
      ? { folderUrl: `https://drive.google.com/drive/folders/${driveFolderId}`, archivos: [] }
      : null,
  )

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const carpeta = carpetaProyecto ?? 'Sesiones sueltas'
  const rutaSesion = `TagMeetings › ${carpeta} › ${titulo}`
  const nadaSeleccionado = !incAnalisis && !incTranscripcion && !incAudio
  const yaArchivado = Boolean(archivadoEn)

  async function handleArchivar() {
    setBusy(true)
    setError('')
    const seleccion: ArchivarSeleccion = {
      analisis: { incluir: incAnalisis, formato: fmtAnalisis },
      transcripcion: {
        incluir: incTranscripcion,
        formato: fmtTranscripcion,
        incluirTimestamps: tsTranscripcion,
        incluirHablantes: spTranscripcion,
      },
      audio: incAudio,
    }
    try {
      const r = await archivarEnDrive(transcripcionId, seleccion)
      if (r.ok) {
        setResultado({ folderUrl: r.folderUrl!, archivos: r.archivos ?? [] })
        router.refresh()
      } else {
        setError(r.error ?? 'No se pudo archivar.')
      }
    } finally {
      setBusy(false)
    }
  }

  // Nombres de preview de lo seleccionado.
  const nombreAnalisis = nombreArchivo(titulo, CONTENIDO_LABEL.analisis, EXT[fmtAnalisis])
  const nombreTranscripcion = nombreArchivo(titulo, CONTENIDO_LABEL.transcripcion, EXT[fmtTranscripcion])
  const nombreAudio = nombreArchivo(titulo, CONTENIDO_LABEL.audio, audioExt || 'audio')

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={() => !busy && onClose()} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Archivar en Drive"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[88vh] overflow-y-auto overscroll-contain rounded-t-3xl border-t border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900 sm:inset-x-auto sm:left-1/2 sm:bottom-auto sm:top-1/2 sm:w-112 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
      >
        <div className="flex justify-center pt-2.5 sm:hidden">
          <span className="h-1.5 w-10 rounded-full bg-stone-300 dark:bg-stone-700" />
        </div>

        <div className="flex items-center gap-2 px-5 pb-1 pt-3">
          <DriveIcon className="size-5 text-brand" />
          <h3 className="text-lg font-extrabold tracking-tight text-stone-900 dark:text-stone-50">
            {yaArchivado ? 'Actualizar en Drive' : 'Archivar en Drive'}
          </h3>
        </div>

        {/* Resultado tras archivar */}
        {resultado && resultado.archivos.length > 0 ? (
          <div className="space-y-4 px-5 pb-5">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950">
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                Guardado en tu Drive
              </p>
              <ul className="mt-2 space-y-1">
                {resultado.archivos.map((n) => (
                  <li key={n} className="truncate text-sm text-emerald-900 dark:text-emerald-100">
                    • {n}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2">
              <a
                href={resultado.folderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tap-scale flex flex-1 items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-bold text-white transition hover:bg-brand-strong"
              >
                Ver carpeta en Drive
              </a>
              <button
                type="button"
                onClick={onClose}
                className="tap-scale flex flex-1 items-center justify-center rounded-xl border border-stone-200 bg-white py-3 text-sm font-bold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                Listo
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-5 pb-5">
            {/* Destino (transparencia) */}
            <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 dark:border-stone-700 dark:bg-stone-800/50">
              <div className="mb-2 flex items-center gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                  Dónde se guardará
                </span>
                <InfoTooltip label="Dónde se guarda">
                  TagMeetings crea esta carpeta dentro de tu Google Drive y organiza ahí cada
                  sesión, para que siempre sepas dónde encontrarla. La app solo puede ver y tocar los
                  archivos que ella misma crea, nunca el resto de tu Drive.
                </InfoTooltip>
              </div>
              <dl className="space-y-1.5 text-sm">
                <div className="flex items-baseline gap-2">
                  <dt className="shrink-0 text-stone-400 dark:text-stone-500">Cuenta</dt>
                  <dd className="min-w-0 flex-1 truncate font-medium text-stone-800 dark:text-stone-100">
                    {email ?? 'Tu cuenta de Google'}
                  </dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="shrink-0 text-stone-400 dark:text-stone-500">Carpeta</dt>
                  <dd className="min-w-0 flex-1 font-medium text-stone-800 dark:text-stone-100">
                    {rutaSesion}
                  </dd>
                </div>
              </dl>
              <Link
                href="/dashboard/ajustes"
                className="tap-scale mt-2 inline-block text-xs font-semibold text-brand"
              >
                Cambiar cuenta
              </Link>
            </div>

            {/* Qué guardar (control) */}
            <div>
              <div className="mb-2 flex items-center gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500">
                  Qué guardar
                </span>
                <InfoTooltip label="Qué guardar">
                  Elige qué archivos de esta sesión respaldar y en qué formato. Puedes guardar el
                  análisis, la transcripción y el audio original, juntos o por separado.
                </InfoTooltip>
              </div>

              <div className="space-y-3">
                {/* Análisis */}
                {hayAnalisis && (
                  <div className="rounded-2xl border border-stone-200 p-3.5 dark:border-stone-700">
                    <button
                      type="button"
                      onClick={() => setIncAnalisis((v) => !v)}
                      className="tap-scale flex w-full items-center gap-3 text-left"
                    >
                      <Check on={incAnalisis} />
                      <span className="flex-1 text-base font-semibold text-stone-800 dark:text-stone-100">
                        Análisis
                      </span>
                    </button>
                    {incAnalisis && (
                      <div className="mt-3 space-y-2 pl-8">
                        <FormatChips formatos={FORMATOS_ANALISIS} value={fmtAnalisis} onChange={setFmtAnalisis} disabled={busy} />
                        <p className="truncate text-xs text-stone-400 dark:text-stone-500">{nombreAnalisis}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Transcripción */}
                <div className="rounded-2xl border border-stone-200 p-3.5 dark:border-stone-700">
                  <button
                    type="button"
                    onClick={() => setIncTranscripcion((v) => !v)}
                    className="tap-scale flex w-full items-center gap-3 text-left"
                  >
                    <Check on={incTranscripcion} />
                    <span className="flex-1 text-base font-semibold text-stone-800 dark:text-stone-100">
                      Transcripción
                    </span>
                  </button>
                  {incTranscripcion && (
                    <div className="mt-3 space-y-2.5 pl-8">
                      <FormatChips formatos={FORMATOS_TRANSCRIPCION} value={fmtTranscripcion} onChange={setFmtTranscripcion} disabled={busy} />
                      <div className="flex flex-wrap gap-x-5 gap-y-2">
                        <MiniToggle checked={tsTranscripcion} onChange={setTsTranscripcion} label="Marcas de tiempo" />
                        <MiniToggle checked={spTranscripcion} onChange={setSpTranscripcion} label="Hablantes" />
                      </div>
                      <p className="truncate text-xs text-stone-400 dark:text-stone-500">{nombreTranscripcion}</p>
                    </div>
                  )}
                </div>

                {/* Audio */}
                {audioDisponible && (
                  <div className="rounded-2xl border border-stone-200 p-3.5 dark:border-stone-700">
                    <button
                      type="button"
                      onClick={() => setIncAudio((v) => !v)}
                      className="tap-scale flex w-full items-center gap-3 text-left"
                    >
                      <Check on={incAudio} />
                      <span className="flex-1 text-base font-semibold text-stone-800 dark:text-stone-100">
                        Audio original
                      </span>
                    </button>
                    {incAudio && (
                      <p className="mt-2 truncate pl-8 text-xs text-stone-400 dark:text-stone-500">{nombreAudio}</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={handleArchivar}
              disabled={busy || nadaSeleccionado}
              className="tap-scale flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-bold text-white transition hover:bg-brand-strong disabled:opacity-50"
            >
              {busy ? 'Guardando en Drive…' : yaArchivado ? 'Actualizar en Drive' : 'Archivar en Drive'}
            </button>
          </div>
        )}

        <div className="pb-safe sm:hidden" />
      </div>
    </>,
    document.body,
  )
}
