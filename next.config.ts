import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// CSP base endurecido. 'unsafe-inline' sigue por los scripts inline de Next.js
// (hidratacion). blob: se mantiene en media-src (MediaRecorder genera blob: URLs)
// y worker-src (Service Worker PWA registra desde blob: en algunos casos).
//
// PRP-TT-V2 Fase 6 — export PDF con @react-pdf/renderer: su motor de layout
// (yoga-layout) compila un modulo WebAssembly y lo carga desde una URL data:.
// Por eso, y SOLO por eso, el CSP necesita:
//   - script-src 'wasm-unsafe-eval': permite COMPILAR WebAssembly sin habilitar
//     el eval() de strings de JS (grant minimo, mas seguro que 'unsafe-eval').
//   - connect-src data:: yoga hace fetch() del wasm inlineado como data: URL.
// Ambos aplican en dev Y prod (el wasm carga igual en ambos).
const connectSrcSources = [
  "'self'",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  // Cloudflare R2 (PRP-TT-004): subida directa del audio via PUT a URL firmada.
  // El bucket usa virtual-hosted-style (<bucket>.<account>.r2.cloudflarestorage.com),
  // el wildcard cubre ambos niveles de subdominio.
  "https://*.r2.cloudflarestorage.com",
  // @react-pdf/yoga-layout carga su wasm desde una URL data: (PRP-TT-V2 Fase 6).
  "data:",
  ...(isDev
    ? ["ws://localhost:*", "ws://127.0.0.1:*", "http://localhost:*"]
    : []),
].join(" ");

const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // R2: preview del logo de marca (Fase 7) servido con signed URL del bucket.
  "img-src 'self' data: blob: https://*.supabase.co https://*.r2.cloudflarestorage.com",
  "font-src 'self' data:",
  `connect-src ${connectSrcSources}`,
  "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(), geolocation=(), payment=()",
  },
  {
    key: "Content-Security-Policy",
    value: cspDirectives,
  },
];

const nextConfig: NextConfig = {
  // No exponer "X-Powered-By: Next.js" (fingerprinting del framework).
  // auditoria-de-seguridad 2026-05-29, D4.
  poweredByHeader: false,
  // QA con Playwright en Windows navega via 127.0.0.1 (localhost falla por
  // IPv6 ::1). Sin esto, Next 16 bloquea /_next/* cross-origin y la app no
  // hidrata en dev. Solo aplica a next dev; en produccion no tiene efecto.
  allowedDevOrigins: ["127.0.0.1"],
  // Paquetes locales del workspace que Next.js debe transpilar (TypeScript directo
  // desde packages/*/src/ sin paso de build separado). Patron canonico Vercel
  // para monorepos internos. Ver PRP-TT-001 Fase 1.
  transpilePackages: ["@bluntag/transcription-core"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
