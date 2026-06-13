#!/usr/bin/env node
// =============================================================================
// r2-objects.cjs — lista (y opcionalmente borra) objetos del bucket R2
// =============================================================================
// USO:
//   node scripts/r2-objects.cjs <prefix>            -> lista objetos bajo prefix
//   node scripts/r2-objects.cjs <prefix> --delete   -> lista y BORRA esos objetos
// Lee creds de .env.local. Util para verificar uploads y limpiar tras QA.
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
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
  const prefix = process.argv[2] || ''
  const doDelete = process.argv.includes('--delete')
  const env = readEnv()
  const client = new S3Client({
    region: 'auto',
    endpoint:
      env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  })

  const list = await client.send(
    new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: prefix }),
  )
  const objs = list.Contents || []
  if (objs.length === 0) {
    console.log(`(0 objetos bajo prefix "${prefix}")`)
    return
  }
  for (const o of objs) {
    const mb = (o.Size / (1024 * 1024)).toFixed(2)
    console.log(`${o.Key}  ${mb} MB`)
  }
  console.log(`TOTAL: ${objs.length} objetos`)

  if (doDelete) {
    for (const o of objs) {
      await client.send(
        new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: o.Key }),
      )
    }
    console.log(`BORRADOS: ${objs.length} objetos.`)
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
