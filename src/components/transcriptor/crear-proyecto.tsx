'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { crearProyecto } from '@/actions/proyectos'
import { COLORES_PROYECTO } from '@/lib/proyectos'

/**
 * Botón "Nuevo proyecto" que despliega un formulario inline (nombre + descripción
 * opcional + color). Estilo app-nativa: sin navegar a otra pantalla.
 */
export function CrearProyecto() {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [nombre, setNombre] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [color, setColor] = useState<string>(COLORES_PROYECTO[0])
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()

  const reset = () => {
    setNombre('')
    setDescripcion('')
    setColor(COLORES_PROYECTO[0])
    setError('')
  }

  const handleGuardar = async () => {
    if (nombre.trim().length === 0) {
      setError('Ponle un nombre al proyecto.')
      return
    }
    setGuardando(true)
    setError('')
    try {
      const res = await crearProyecto({ nombre, descripcion, color })
      if (!res.ok) {
        setError(res.error ?? 'No se pudo crear.')
        setGuardando(false)
        return
      }
      reset()
      setAbierto(false)
      setGuardando(false)
      startTransition(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setGuardando(false)
    }
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="tap-scale flex w-full items-center gap-4 rounded-2xl bg-brand p-4 text-white shadow-sm transition hover:bg-brand-strong"
      >
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20">
          <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 text-left text-base font-bold">Nuevo proyecto</span>
      </button>
    )
  }

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div>
        <label htmlFor="nuevo-proyecto-nombre" className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
          Nombre del proyecto
        </label>
        <input
          id="nuevo-proyecto-nombre"
          type="text"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Ej. Cliente — Acme Corp"
          maxLength={120}
          autoFocus
          disabled={guardando}
          className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
      </div>

      <div className="mt-3">
        <label htmlFor="nuevo-proyecto-desc" className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
          Descripción <span className="font-normal text-stone-400">(opcional)</span>
        </label>
        <textarea
          id="nuevo-proyecto-desc"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          placeholder="¿De qué trata este proyecto?"
          rows={2}
          maxLength={500}
          disabled={guardando}
          className="block w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
      </div>

      <div className="mt-3">
        <span className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">Color</span>
        <div className="flex flex-wrap gap-2.5">
          {COLORES_PROYECTO.map((c) => {
            const activo = c === color
            return (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                aria-pressed={activo}
                disabled={guardando}
                className={`size-8 rounded-full transition ${activo ? 'ring-2 ring-offset-2 ring-stone-400 dark:ring-offset-stone-900' : ''}`}
                style={{ backgroundColor: c }}
              />
            )
          })}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={handleGuardar}
          disabled={guardando}
          className="tap-scale flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white transition hover:bg-brand-strong disabled:opacity-50"
        >
          {guardando ? 'Creando…' : 'Crear proyecto'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset()
            setAbierto(false)
          }}
          disabled={guardando}
          className="tap-scale rounded-xl border border-stone-200 px-4 py-2.5 text-sm font-semibold text-stone-500 transition hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}
