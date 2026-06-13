'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { login } from '@/actions/auth'

export function LoginForm() {
  const searchParams = useSearchParams()
  const callbackError = searchParams.get('error')
  const [error, setError] = useState<string | null>(
    callbackError === 'auth_callback_failed'
      ? 'Error al confirmar la sesión. Intenta de nuevo.'
      : null
  )
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await login(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <form action={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Contraseña
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="tap-scale w-full rounded-xl bg-brand px-4 py-2 text-white hover:bg-brand-strong disabled:opacity-50"
        >
          {loading ? 'Iniciando sesión...' : 'Iniciar sesión'}
        </button>

        <p className="text-center text-sm text-stone-600 dark:text-stone-400">
          <Link
            href="/forgot-password"
            className="text-brand hover:underline dark:text-brand"
          >
            ¿Olvidaste tu contraseña?
          </Link>
        </p>
      </form>
    </div>
  )
}
