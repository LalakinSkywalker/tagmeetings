#!/usr/bin/env node
// =============================================================================
// r2-setup-cors.cjs — configura el CORS del bucket R2 (PRP-TT-004)
// =============================================================================
// USO: node scripts/r2-setup-cors.cjs
// Permite que el navegador suba (PUT) y reproduzca (GET) directo al bucket R2
// desde los origenes de la app. La seguridad real esta en la URL firmada; CORS
// solo habilita el origen del navegador. Lee creds de .env.local (no las imprime).
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')
const {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} = require('@aws-sdk/client-s3')

function readEnv() {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', '.env.local'), 'utf8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

async function main() {
  const env = readEnv()
  const accountId = env.R2_ACCOUNT_ID
  const bucket = env.R2_BUCKET
  if (!accountId || !bucket || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error('faltan vars R2 en .env.local')
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  })

  // Origenes permitidos: localhost (dev) + el sitio del usuario (de .env.local) +
  // previews de Vercel. Sin dominios hardcodeados de nadie en particular.
  const siteUrl = env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3050'
  const allowedOrigins = Array.from(
    new Set(['http://localhost:3050', siteUrl, 'https://*.vercel.app'].filter(Boolean)),
  )

  const rule = {
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    AllowedOrigins: allowedOrigins,
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  }

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: [rule] },
    }),
  )
  console.log(`CORS aplicado al bucket "${bucket}".`)

  const got = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
  console.log('CORS actual:')
  console.log(JSON.stringify(got.CORSRules, null, 2))
}

main().catch((err) => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
