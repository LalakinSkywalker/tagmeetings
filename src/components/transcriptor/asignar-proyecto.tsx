'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { SelectMenu, type SelectOption } from '@/components/ui/select-menu'
import { asignarSesionAProyecto } from '@/actions/proyectos'

interface Props {
  transcripcionId: string
  proyectoIdActual: string | null
  proyectos: { id: string; nombre: string }[]
}

/**
 * Control para asignar / mover esta sesión a un proyecto (o dejarla suelta).
 * Reusa el SelectMenu unificado. Persiste al instante con la server action.
 */
export function AsignarProyecto({ transcripcionId, proyectoIdActual, proyectos }: Props) {
  const router = useRouter()
  const [value, setValue] = useState(proyectoIdActual ?? '')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()

  const options: SelectOption[] = [
    { value: '', label: 'Sin proyecto' },
    ...proyectos.map((p) => ({ value: p.id, label: p.nombre })),
  ]

  const handleChange = async (nuevo: string) => {
    const previo = value
    setValue(nuevo)
    setGuardando(true)
    setError('')
    try {
      const res = await asignarSesionAProyecto(transcripcionId, nuevo === '' ? null : nuevo)
      if (!res.ok) {
        setError(res.error ?? 'No se pudo asignar.')
        setValue(previo)
        setGuardando(false)
        return
      }
      setGuardando(false)
      startTransition(() => router.refresh())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setValue(previo)
      setGuardando(false)
    }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">Proyecto</span>
      </div>
      <SelectMenu
        value={value}
        onChange={handleChange}
        options={options}
        size="sm"
        ariaLabel="Proyecto de esta sesión"
        placeholder="Sin proyecto"
        action={{ label: 'Administrar proyectos', onClick: () => router.push('/dashboard/proyectos') }}
        disabled={guardando}
      />
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
