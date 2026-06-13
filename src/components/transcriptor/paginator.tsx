'use client'

import { useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

interface Props {
  total: number
  page: number
  pageSize: number
  pageCount: number
}

/**
 * Paginador con botones "Primera / Anterior / Siguiente / Última" + indicador
 * "Página X de Y". Sincronizado con URL param `page`. Si solo hay 1 página
 * o cero items, NO se renderiza (evita ruido).
 */
export function Paginator({ total, page, pageSize, pageCount }: Props) {
  const router = useRouter()
  const params = useSearchParams()
  const [isPending, startTransition] = useTransition()

  if (pageCount <= 1) return null

  function goTo(p: number) {
    const next = new URLSearchParams(params.toString())
    if (p <= 1) {
      next.delete('page')
    } else {
      next.set('page', String(p))
    }
    const search = next.toString()
    startTransition(() => {
      router.replace(search ? `/dashboard?${search}` : '/dashboard')
    })
  }

  const firstItemOnPage = total === 0 ? 0 : (page - 1) * pageSize + 1
  const lastItemOnPage = Math.min(page * pageSize, total)

  const canPrev = page > 1
  const canNext = page < pageCount

  const btn =
    'inline-flex h-8 items-center justify-center rounded-md border border-gray-300 px-2.5 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800'

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-2 text-xs text-gray-500 dark:text-gray-400">
      <span>
        Mostrando{' '}
        <span className="font-medium text-gray-700 dark:text-gray-200">
          {firstItemOnPage}–{lastItemOnPage}
        </span>{' '}
        de{' '}
        <span className="font-medium text-gray-700 dark:text-gray-200">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => goTo(1)}
          disabled={!canPrev || isPending}
          className={btn}
          aria-label="Primera página"
        >
          «
        </button>
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={!canPrev || isPending}
          className={btn}
          aria-label="Página anterior"
        >
          ‹ Anterior
        </button>
        <span className="px-3 text-xs text-gray-600 dark:text-gray-300">
          Página{' '}
          <span className="font-medium text-gray-900 dark:text-gray-100">{page}</span>{' '}
          de{' '}
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {pageCount}
          </span>
        </span>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={!canNext || isPending}
          className={btn}
          aria-label="Página siguiente"
        >
          Siguiente ›
        </button>
        <button
          type="button"
          onClick={() => goTo(pageCount)}
          disabled={!canNext || isPending}
          className={btn}
          aria-label="Última página"
        >
          »
        </button>
      </div>
    </div>
  )
}
