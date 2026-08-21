// apps/desktop/electron/services/util/sensitive-files.ts
//
// Fail-closed denylist for files/dirs that must NEVER be swept into an LLM
// prompt (STEAL 2026-07-09, caveman). Both folder-ingestion paths — RAG
// walkFolder (chat attach-folder → cloud chat) and design readFolderContext
// (→ cloud design providers) — filtered ONLY by a text-extension whitelist. A
// `secrets.yaml`, `credentials.ts`, `.env.production`, or a `deploy.sh` full of
// tokens has a "text" extension and would sail straight into a cloud prompt.
//
// This is defence-in-depth: it complements (does not replace) the extension
// whitelist and the outbound secret scrubber. Name-based, case-insensitive,
// and deliberately broad — a false positive just skips one file; a false
// negative leaks a credential.

// Secret-bearing filenames (exact, case-insensitive) regardless of extension.
const SENSITIVE_NAMES = new Set([
  '.env', '.npmrc', '.netrc', '.pgpass', '.htpasswd', '.dockercfg',
  'credentials', 'credentials.json', 'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts', 'authorized_keys',
  'serviceaccount.json', 'service-account.json', 'gha-creds.json',
  '.git-credentials', '.pypirc', '.terraformrc', 'terraform.tfvars',
])

// Substring hints — any filename CONTAINING one of these (case-insensitive) is
// treated as sensitive. Kept tight to avoid nuking ordinary source.
const SENSITIVE_SUBSTRINGS = [
  'secret', 'password', 'passwd', 'credential', 'apikey', 'api_key', 'api-key',
  'private_key', 'privatekey', 'access_token', 'accesstoken', 'client_secret',
]

// Extensions that are ALWAYS secret material (keys, certs, keystores, wallets).
const SENSITIVE_EXTS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.p8', '.keystore', '.jks', '.asc', '.gpg', '.pgp',
  '.crt', '.cer', '.der', '.ppk', '.kdbx', '.wallet', '.keypair',
])

// Directories whose entire subtree is off-limits (in addition to the caller's
// own SKIP_DIRS for build noise).
const SENSITIVE_DIRS = new Set([
  '.ssh', '.aws', '.gnupg', '.gpg', '.docker', '.kube', '.gcloud', '.azure', 'secrets',
])

function lastExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

/** True if a FILE name looks like it carries secrets and must not be ingested. */
export function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SENSITIVE_NAMES.has(lower)) return true
  if (SENSITIVE_EXTS.has(lastExt(lower))) return true
  // .env, .env.local, .env.production, dev.env, etc.
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) return true
  // id_rsa.pub, credentials.backup, secrets.old, my-secret-config.yaml, …
  if (SENSITIVE_SUBSTRINGS.some(s => lower.includes(s))) return true
  return false
}

/** True if a DIRECTORY name's whole subtree must be skipped (credential stores). */
export function isSensitiveDirName(name: string): boolean {
  return SENSITIVE_DIRS.has(name.toLowerCase())
}
