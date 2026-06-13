'use client'

// =============================================================================
// AjustesMarca — perfil + branding del usuario para los exports (Fase 7)
// =============================================================================
// - Nombre del perfil (profiles.full_name).
// - Logo (R2): subir PNG/JPG, preview, quitar. Aparece en el PDF (Fase 6).
// - Color de marca: el acento del PDF. Solo el primario (el que realmente influye
//   el export); no exponemos un secundario decorativo (config siempre influye el comportamiento real).
// Patrón mobile-native: label + ⓘ + control, tap-scale, guardado con feedback.
// =============================================================================

import { useRef, useState, useTransition } from 'react'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  updateMyProfile,
  updateMySettings,
  getBrandLogoUploadUrl,
  saveBrandLogoPath,
  removeBrandLogo,
} from '@/actions/settings'

const DEFAULT_BRAND = '#ff8133'
const LOGO_MAX_BYTES = 2 * 1024 * 1024

interface Props {
  initialFullName: string
  initialColor: string | null
  initialLogoUrl: string | null
}

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; msg: string }

export function AjustesMarca({ initialFullName, initialColor, initialLogoUrl }: Props) {
  const [fullName, setFullName] = useState(initialFullName)
  const [savedName, setSavedName] = useState(initialFullName)
  const [color, setColor] = useState(initialColor ?? DEFAULT_BRAND)
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [uploading, setUploading] = useState(false)
  const [, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  const saveName = () => {
    const trimmed = fullName.trim()
    if (trimmed === savedName.trim()) return
    setStatus({ kind: 'saving' })
    startTransition(async () => {
      const res = await updateMyProfile({ fullName: trimmed })
      if (res.ok) {
        setSavedName(trimmed)
        setStatus({ kind: 'saved' })
      } else {
        setStatus({ kind: 'error', msg: res.error ?? 'No se pudo guardar.' })
      }
    })
  }

  const saveColor = (hex: string) => {
    setStatus({ kind: 'saving' })
    startTransition(async () => {
      const res = await updateMySettings({ brandColorPrimario: hex })
      setStatus(res.ok ? { kind: 'saved' } : { kind: 'error', msg: res.error ?? 'No se pudo guardar.' })
    })
  }

  const onPickLogo = async (file: File) => {
    setStatus({ kind: 'idle' })
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setStatus({ kind: 'error', msg: 'El logo debe ser PNG o JPG.' })
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setStatus({ kind: 'error', msg: 'El logo debe pesar menos de 2 MB.' })
      return
    }
    setUploading(true)
    try {
      const up = await getBrandLogoUploadUrl({ mime: file.type, sizeBytes: file.size })
      if (!up.ok || !up.signedUrl || !up.path) {
        setStatus({ kind: 'error', msg: up.error ?? 'No se pudo preparar la subida.' })
        return
      }
      const put = await fetch(up.signedUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      })
      if (!put.ok) {
        setStatus({ kind: 'error', msg: `Falló la subida (HTTP ${put.status}).` })
        return
      }
      const saved = await saveBrandLogoPath(up.path)
      if (!saved.ok) {
        setStatus({ kind: 'error', msg: saved.error ?? 'No se pudo guardar el logo.' })
        return
      }
      setLogoUrl(URL.createObjectURL(file))
      setStatus({ kind: 'saved' })
    } catch (err) {
      setStatus({ kind: 'error', msg: err instanceof Error ? err.message : 'Error al subir.' })
    } finally {
      setUploading(false)
    }
  }

  const onRemoveLogo = () => {
    setStatus({ kind: 'saving' })
    startTransition(async () => {
      const res = await removeBrandLogo()
      if (res.ok) {
        setLogoUrl(null)
        setStatus({ kind: 'saved' })
      } else {
        setStatus({ kind: 'error', msg: res.error ?? 'No se pudo quitar.' })
      }
    })
  }

  return (
    <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-bold tracking-wider text-stone-400 uppercase dark:text-stone-500">
            Mi marca
          </h3>
          <InfoTooltip label="Para qué sirve">
            Tu nombre, logo y color aparecen en los PDF que descargas o archivas en
            Drive. Así tus reportes salen con tu identidad.
          </InfoTooltip>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="space-y-4">
        {/* Nombre */}
        <div>
          <label htmlFor="cfg-nombre" className="mb-1.5 block text-base font-medium text-stone-700 dark:text-stone-200">
            Nombre
          </label>
          <input
            id="cfg-nombre"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            onBlur={saveName}
            maxLength={80}
            placeholder="Tu nombre o el de tu negocio"
            className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          />
        </div>

        {/* Logo */}
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-base font-medium text-stone-700 dark:text-stone-200">Logo</span>
            <InfoTooltip label="Sobre el logo">
              PNG o JPG, hasta 2 MB. Aparece arriba de cada PDF. Si no subes ninguno,
              usamos el de TagMeetings.
            </InfoTooltip>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-800">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- preview de blob/url firmada, no asset estático
                <img src={logoUrl} alt="Logo" className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-xs text-stone-400">Sin logo</span>
              )}
            </div>
            <div className="flex flex-1 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="tap-scale rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm font-semibold text-stone-700 shadow-sm transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                {uploading ? 'Subiendo…' : logoUrl ? 'Cambiar' : 'Subir logo'}
              </button>
              {logoUrl && (
                <button
                  type="button"
                  onClick={onRemoveLogo}
                  disabled={uploading}
                  className="tap-scale rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm font-semibold text-red-600 shadow-sm transition hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-red-400 dark:hover:bg-stone-800"
                >
                  Quitar
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onPickLogo(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>

        {/* Color de marca */}
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label htmlFor="cfg-color" className="text-base font-medium text-stone-700 dark:text-stone-200">
              Color de marca
            </label>
            <InfoTooltip label="Sobre el color">
              Es el color de acento de tus PDF: títulos de sección, líneas y viñetas.
              Por defecto, el naranja de la app.
            </InfoTooltip>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="cfg-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              onBlur={() => saveColor(color)}
              className="h-10 w-14 shrink-0 cursor-pointer rounded-md border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900"
              aria-label="Color de marca"
            />
            <span className="font-mono text-sm text-stone-500 dark:text-stone-400">{color.toUpperCase()}</span>
            {color.toLowerCase() !== DEFAULT_BRAND && (
              <button
                type="button"
                onClick={() => {
                  setColor(DEFAULT_BRAND)
                  saveColor(DEFAULT_BRAND)
                }}
                className="tap-scale ml-auto text-sm font-medium text-stone-500 underline-offset-2 hover:underline dark:text-stone-400"
              >
                Restablecer
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function StatusPill({ status }: { status: Status }) {
  if (status.kind === 'idle') return null
  if (status.kind === 'saving') return <span className="text-xs font-medium text-stone-400">Guardando…</span>
  if (status.kind === 'saved') return <span className="text-xs font-medium text-green-600 dark:text-green-400">Guardado ✓</span>
  return <span className="text-xs font-medium text-red-600 dark:text-red-400">{status.msg}</span>
}
