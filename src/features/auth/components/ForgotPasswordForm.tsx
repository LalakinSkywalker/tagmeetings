'use client'

import { useState } from 'react'
import { resetPassword } from '@/actions/auth'

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await resetPassword(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    } else {
      setSuccess(true)
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="text-center">
        <p className="text-green-600 dark:text-green-400">
          Revisa tu email — te enviamos un link para restablecer tu contraseña.
        </p>
      </div>
    )
  }

  return (
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

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="tap-scale w-full rounded-xl bg-brand px-4 py-2 text-white hover:bg-brand-strong disabled:opacity-50"
      >
        {loading ? 'Enviando...' : 'Enviar link de restablecimiento'}
      </button>
    </form>
  )
}
