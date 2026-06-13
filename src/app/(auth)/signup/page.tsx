import Link from 'next/link'
import Image from 'next/image'
import { SignupForm } from '@/features/auth/components'

export default function SignupPage() {
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
          <h1 className="text-3xl font-extrabold tracking-tight">Crear cuenta</h1>
          <p className="mt-2 text-stone-600 dark:text-stone-400">
            Empieza a usar TagMeetings
          </p>
        </div>

        <SignupForm />

        <p className="text-center text-sm text-stone-600 dark:text-stone-400">
          ¿Ya tienes cuenta?{' '}
          <Link href="/login" className="text-brand hover:underline dark:text-brand">
            Inicia sesión
          </Link>
        </p>
      </div>
    </div>
  )
}
