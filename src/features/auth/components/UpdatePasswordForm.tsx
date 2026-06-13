'use client'

import { useState } from 'react'
import { updatePassword } from '@/actions/auth'

export function UpdatePasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await updatePassword(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Nueva contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={6}
          autoComplete="new-password"
          className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-ring/50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="tap-scale w-full rounded-xl bg-brand px-4 py-2 text-white hover:bg-brand-strong disabled:opacity-50"
      >
        {loading ? 'Actualizando...' : 'Actualizar contraseña'}
      </button>
    </form>
  )
}
