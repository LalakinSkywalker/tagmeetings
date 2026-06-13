import Link from 'next/link'
import { ForgotPasswordForm } from '@/features/auth/components'

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 dark:bg-stone-950">
      <div className="w-full max-w-md space-y-8 rounded-lg bg-white p-8 shadow-sm dark:bg-stone-900">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Restablecer contraseña</h1>
          <p className="mt-2 text-stone-600 dark:text-stone-400">
            Ingresa tu email para recibir un link
          </p>
        </div>

        <ForgotPasswordForm />

        <p className="text-center text-sm text-stone-600 dark:text-stone-400">
          <Link href="/login" className="text-brand hover:underline dark:text-brand">
            Volver al inicio de sesión
          </Link>
        </p>
      </div>
    </div>
  )
}
