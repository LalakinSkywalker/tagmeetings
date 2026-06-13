#!/usr/bin/env node
// =============================================================================
// create-qa-user.cjs — crea user QA en auth.users del proyecto
// =============================================================================
// USO: node scripts/create-qa-user.cjs <email>
// Idempotente: si el user ya existe (HTTP 422 email_exists), termina ok.
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')

const ENV_PATH = path.resolve(__dirname, '..', '.env.local')

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('ERROR: no encuentro .env.local en', ENV_PATH)
    process.exit(1)
  }
  const raw = fs.readFileSync(ENV_PATH, 'utf8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('USO: node scripts/create-qa-user.cjs <email>')
    process.exit(1)
  }

  const env = readEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    console.error('ERROR: faltan vars en .env.local')
    process.exit(1)
  }

  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      email_confirm: true,  // skip verificacion para QA
    }),
  })

  if (res.status === 200 || res.status === 201) {
    console.log('CREATED:', email)
    return
  }

  const detail = await res.text()
  if (res.status === 422 && /already.*exists|email_exists|already.*registered/i.test(detail)) {
    console.log('EXISTS:', email)
    return
  }

  console.error(`HTTP ${res.status}:`, detail.slice(0, 500))
  process.exit(1)
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err.message)
  process.exit(1)
})
