import { Suspense } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { LoginForm } from '@/features/auth/components'

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 p-4 dark:bg-stone-950">
      <div className="w-full max-w-md space-y-8 rounded-3xl bg-white p-8 shadow-sm dark:bg-stone-900">
        <div className="text-center">
          <Image
            src="/logo-tagflow-small.png"
            alt="TagMeetings"
            width={84}
            height={84}
            priority
            className="mx-auto mb-3"
          />
          <h1 className="text-3xl font-extrabold tracking-tight">TagMeetings</h1>
          <p className="mt-2 text-stone-600 dark:text-stone-400">
            Inicia sesión en tu cuenta
          </p>
        </div>

        <Suspense fallback={<div className="text-center text-sm text-stone-500">Cargando...</div>}>
          <LoginForm />
        </Suspense>

        <p className="text-center text-sm text-stone-600 dark:text-stone-400">
          ¿No tienes cuenta?{' '}
          <Link href="/signup" className="text-brand hover:underline dark:text-brand">
            Regístrate
          </Link>
        </p>
      </div>
    </div>
  )
}
