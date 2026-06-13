'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { actualizarProyecto, borrarProyecto } from '@/actions/proyectos'
import { COLORES_PROYECTO } from '@/lib/proyectos'

interface Props {
  proyecto: {
    id: string
    nombre: string
    descripcion: string
    color: string
  }
}

/**
 * Tarjeta de info + acciones de un proyecto en su detalle: muestra color y
 * descripción, permite editar (nombre/descripción/color) en línea y borrar
 * (con confirmación). Borrar NO borra las sesiones (quedan sueltas).
 */
export function ProyectoAcciones({ proyecto }: Props) {
  const router = useRouter()
  const [editando, setEditando] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const [nombre, setNombre] = useState(proyecto.nombre)
  const [descripcion, setDescripcion] = useState(proyecto.descripcion)
  const [color, setColor] = useState(proyecto.color)
  const [guardando, setGuardando] = useState(false)
  const [borrando, setBorrando] = useState(false)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()

  const handleGuardar = async () => {
    if (nombre.trim().length === 0) {
      setError('El proyecto necesita un nombre.')
      return
    }
    setGuardando(true)
    setError('')
    try {
      const res = await actualizarProyecto(proyecto.id, { nombre, descripcion, color })
      if (!res.ok) {
        setError(res.error ?? 'No se pudo guardar.')
        setGuardando(false)
        return
      }
      setEditando(false)
      setGuardando(false)
      startTransition(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setGuardando(false)
    }
  }

  const handleBorrar = async () => {
    setBorrando(true)
    setError('')
    try {
      const res = await borrarProyecto(proyecto.id)
      if (!res.ok) {
        setError(res.error ?? 'No se pudo borrar.')
        setBorrando(false)
        return
      }
      startTransition(() => router.push('/dashboard/proyectos'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBorrando(false)
    }
  }

  if (editando) {
    return (
      <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <div>
          <label htmlFor="editar-proyecto-nombre" className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
            Nombre
          </label>
          <input
            id="editar-proyecto-nombre"
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            maxLength={120}
            disabled={guardando}
            className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          />
        </div>
        <div className="mt-3">
          <label htmlFor="editar-proyecto-desc" className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">
            Descripción <span className="font-normal text-stone-400">(opcional)</span>
          </label>
          <textarea
            id="editar-proyecto-desc"
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            rows={2}
            maxLength={500}
            disabled={guardando}
            className="block w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2.5 text-base shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          />
        </div>
        <div className="mt-3">
          <span className="mb-1.5 block text-sm font-medium text-stone-700 dark:text-stone-200">Color</span>
          <div className="flex flex-wrap gap-2.5">
            {COLORES_PROYECTO.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                aria-pressed={c === color}
                disabled={guardando}
                className={`size-8 rounded-full transition ${c === color ? 'ring-2 ring-stone-400 ring-offset-2 dark:ring-offset-stone-900' : ''}`}
                style={{ backgroundColor: c }}
              />
            ))}
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
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={() => {
              setNombre(proyecto.nombre)
              setDescripcion(proyecto.descripcion)
              setColor(proyecto.color)
              setError('')
              setEditando(false)
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

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-2xl"
          style={{ backgroundColor: `${proyecto.color}22` }}
        >
          <svg viewBox="0 0 24 24" fill="none" className="size-5" style={{ color: proyecto.color }} aria-hidden="true">
            <path
              d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-sm text-stone-600 dark:text-stone-300">
          {proyecto.descripcion || <span className="text-stone-400 dark:text-stone-500">Sin descripción</span>}
        </p>
      </div>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setEditando(true)}
          className="tap-scale flex-1 rounded-xl border border-stone-200 py-2 text-center text-sm font-semibold text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          Editar
        </button>
        {confirmando ? (
          <>
            <button
              type="button"
              onClick={handleBorrar}
              disabled={borrando}
              className="tap-scale flex-1 rounded-xl bg-red-600 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {borrando ? 'Borrando…' : 'Confirmar'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmando(false)}
              disabled={borrando}
              className="tap-scale rounded-xl border border-stone-200 px-3 py-2 text-sm font-semibold text-stone-500 transition hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              No
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            className="tap-scale rounded-xl border border-stone-200 px-3 py-2 text-sm font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50 dark:border-stone-700 dark:text-red-400 dark:hover:border-red-800 dark:hover:bg-red-950/40"
          >
            Borrar
          </button>
        )}
      </div>
    </div>
  )
}
