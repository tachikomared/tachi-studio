// test/unit/sensitiveFiles.test.ts — fail-closed secret-file denylist that
// keeps credential-bearing files out of folder→LLM ingestion (STEAL 07-09).
import { describe, it, expect } from 'vitest'
import { isSensitiveFileName, isSensitiveDirName } from '../../electron/services/util/sensitive-files'

describe('isSensitiveFileName', () => {
  it('blocks .env and its variants', () => {
    for (const n of ['.env', '.env.local', '.env.production', 'dev.env', '.ENV'])
      expect(isSensitiveFileName(n), n).toBe(true)
  })

  it('blocks key/cert/keystore extensions', () => {
    for (const n of ['server.pem', 'tls.key', 'bundle.p12', 'store.jks', 'wallet.kdbx', 'cert.crt', 'sig.asc'])
      expect(isSensitiveFileName(n), n).toBe(true)
  })

  it('blocks known credential filenames regardless of case', () => {
    for (const n of ['id_rsa', 'ID_RSA', 'credentials.json', '.npmrc', '.netrc', 'terraform.tfvars', 'known_hosts'])
      expect(isSensitiveFileName(n), n).toBe(true)
  })

  it('blocks names CONTAINING secret hints (the .yaml/.ts trap)', () => {
    for (const n of ['secrets.yaml', 'my-secret-config.ts', 'apikeys.json', 'client_secret.txt', 'db_password.env', 'access_token.sh'])
      expect(isSensitiveFileName(n), n).toBe(true)
  })

  it('lets ordinary source through', () => {
    for (const n of ['index.ts', 'README.md', 'app.tsx', 'styles.css', 'config.yaml', 'notes.txt', 'main.py', 'deploy.md'])
      expect(isSensitiveFileName(n), n).toBe(false)
  })
})

describe('isSensitiveDirName', () => {
  it('blocks credential-store directories', () => {
    for (const d of ['.ssh', '.aws', '.gnupg', '.kube', '.docker', 'secrets'])
      expect(isSensitiveDirName(d), d).toBe(true)
  })
  it('lets ordinary directories through', () => {
    for (const d of ['src', 'components', 'node_modules', 'docs'])
      expect(isSensitiveDirName(d), d).toBe(false)
  })
})
