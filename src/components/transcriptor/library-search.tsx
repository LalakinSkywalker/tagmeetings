'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Buscador premium de la Biblioteca. Sincroniza el termino con ?q= en la URL
 * (server component re-consulta). Los filtros avanzados (categoria/plantilla/
 * fecha) se integran en un panel durante la migracion completa de la fase.
 */
export function LibrarySearch() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [value, setValue] = useState(searchParams.get('q') ?? '')
  const [pending, startTransition] = useTransition()

  function submit(next: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (next.trim()) params.set('q', next.trim())
    else params.delete('q')
    params.delete('page')
    startTransition(() => {
      router.push(`/dashboard?${params.toString()}`)
    })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit(value)
      }}
      className="relative"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-stone-400"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth={1.8} />
        <path d="m20 20-3-3" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          if (e.target.value === '') submit('')
        }}
        placeholder="Buscar en mis transcripciones"
        className="h-11 w-full rounded-2xl border border-stone-200 bg-white pr-4 pl-10 text-sm text-stone-900 shadow-sm transition placeholder:text-stone-400 focus:border-brand focus:ring-2 focus:ring-brand-ring/50 focus:outline-none dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100"
        aria-label="Buscar transcripciones"
      />
      {pending ? (
        <span className="absolute top-1/2 right-3.5 size-3 -translate-y-1/2 animate-spin rounded-full border-2 border-stone-300 border-t-brand" />
      ) : null}
    </form>
  )
}
