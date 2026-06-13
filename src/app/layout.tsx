import type { Metadata, Viewport } from "next";
import { Raleway, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/theme-provider";
import "./globals.css";

// Raleway = tipografia corporativa Bluntag AI Studio (coherencia de marca con la landing).
const raleway = Raleway({
  variable: "--font-raleway",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

// Geist Mono se conserva solo para timestamps / cifras tabulares.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TagMeetings",
  description:
    "Asistente de reuniones: graba, transcribe con diarizacion y obten analisis estructurado.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "TagMeetings",
    startupImage: ["/icon-512.png"],
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1917" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${raleway.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
        <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="TagMeetings" />
        <meta name="application-name" content="TagMeetings" />
      </head>
      <body className="min-h-dvh bg-stone-50 text-stone-900 antialiased dark:bg-stone-950 dark:text-stone-100">
        <ThemeProvider>{children}</ThemeProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js');
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
