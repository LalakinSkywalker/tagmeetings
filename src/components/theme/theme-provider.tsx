'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
}

export function ThemeProvider({ children }: Props) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      storageKey="tagtranscriptor-theme"
    >
      {children}
    </NextThemesProvider>
  )
}
