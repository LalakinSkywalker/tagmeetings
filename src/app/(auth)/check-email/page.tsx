import Link from 'next/link'

export default function CheckEmailPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 dark:bg-stone-950">
      <div className="w-full max-w-md space-y-8 rounded-lg bg-white p-8 text-center shadow-sm dark:bg-stone-900">
        <h1 className="text-3xl font-bold">Revisa tu email</h1>
        <p className="text-stone-600 dark:text-stone-400">
          Te enviamos un link de confirmación. Revisa tu bandeja para completar tu registro.
        </p>
        <Link
          href="/login"
          className="inline-block text-brand hover:underline dark:text-brand"
        >
          Volver al inicio de sesión
        </Link>
      </div>
    </div>
  )
}
