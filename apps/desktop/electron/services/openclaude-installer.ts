import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'
// Canonical PRIVATE-MODE egress denylists. WRAPPER_TEMPLATE below interpolates
// these at build time so the sidecar wrapper enforces the SAME policy as the
// main process — see the "PRIVATE MODE Tier 2" block inside the template.
import {
  NETWORK_TOOLS_DENIED_IN_PRIVATE,
  BASH_NETWORK_DENY,
  BASH_INTERPRETER_EXFIL,
} from './egress-policy'
// The agent-harness OpenGateway pin — interpolated into the wrapper's
// /preflight fallback so even the "env var missing" path probes the model the
// harness actually routes (one source of truth, packages/core agent-route.ts).
import { OPENGATEWAY_AGENT_MODEL } from '@tachi/core'

/** Pinned SDK version — bump here to force a clean reinstall on all clients. */
const OPENCLAUDE_SDK_VERSION = '0.27.0'

/**
 * Packages `dist/sdk.mjs` STATICALLY imports but does NOT depend on.
 *
 * From 0.23.0 upstream chased a "zero-warning, minimal npm install" (#1784,
 * #2019) by moving these out of `dependencies` into OPTIONAL
 * `peerDependencies` — while the bundle kept 14 hard top-level
 * `import … from "@anthropic-ai/sdk"` statements and 4 from
 * `@modelcontextprotocol/sdk`. npm never installs optional peers, so
 * `npm install @gitlawb/openclaude@0.27.0` alone produces a tree that cannot
 * be imported at all:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/sdk'
 *   imported from …/node_modules/@gitlawb/openclaude/dist/sdk.mjs
 *
 * — thrown at ESM link time, before a single line of the wrapper runs, so the
 * sidecar dies with exit code 1 on every start. Reproduced 2026-08-02 in a
 * clean directory; it is deterministic, not environment-specific. The
 * "~60 deps → 3" figure in OPENCLAUDE-UPDATE-ASSESSMENT-2026-08-01.md read
 * `dependencies` only and missed the peer block.
 *
 * These are therefore MANDATORY for the SDK entrypoint. Versions are exact
 * (not the caret ranges upstream declares — `^0.94.0` / `^1.29.0`) so every
 * client resolves the same tree; both satisfy the declared peer ranges.
 * `react` / `react-reconciler` are ALSO optional peers but only ever reached
 * through a guarded dynamic `import("react")` in the CLI's swarm UI, which the
 * SDK path never touches — deliberately not installed.
 *
 * Bump these together with OPENCLAUDE_SDK_VERSION, and re-read the new
 * package's `peerDependencies` when you do.
 */
const OPENCLAUDE_REQUIRED_PEERS: Readonly<Record<string, string>> = {
  '@anthropic-ai/sdk':          '0.94.0',
  '@modelcontextprotocol/sdk':  '1.30.0',
}

/** Root directory where openclaude is npm-installed. */
function openclaudeBase(): string {
  return join(app.getPath('userData'), 'sidecars', 'openclaude')
}

/** node_modules entry point for the HTTP server wrapper. */
export function openclaudeEntry(): string {
  return join(openclaudeBase(), 'start-server.mjs')
}

/** Installed version of a package in the sidecar tree, or null if absent/unreadable. */
function installedVersion(pkgName: string): string | null {
  const pkgJson = join(openclaudeBase(), 'node_modules', ...pkgName.split('/'), 'package.json')
  if (!existsSync(pkgJson)) return null
  try {
    return (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * Names of OPENCLAUDE_REQUIRED_PEERS that are absent or at the wrong version.
 * Empty on a healthy tree. Exported as the diagnosable seam behind
 * isOpenClaudeInstalled() — "not installed" should be answerable with *which*
 * package is missing, not just a boolean.
 */
export function missingOpenClaudePeers(): string[] {
  return Object.entries(OPENCLAUDE_REQUIRED_PEERS)
    .filter(([name, version]) => installedVersion(name) !== version)
    .map(([name]) => name)
}

/**
 * True when the wrapper script, the pinned SDK version, AND every statically
 * imported peer are present at their pinned versions.
 *
 * The peer check is load-bearing, not defensive: the first 0.27.0 install
 * shipped without them, and a version-only check reports that broken tree as
 * "installed" forever — the sidecar fails at import on every run and nothing
 * ever triggers a repair. Including the peers makes such a tree fail this
 * check, so the next run reinstalls and heals itself.
 */
export function isOpenClaudeInstalled(): boolean {
  if (!existsSync(openclaudeEntry())) return false
  if (installedVersion('@gitlawb/openclaude') !== OPENCLAUDE_SDK_VERSION) return false
  return missingOpenClaudePeers().length === 0
}

export interface OpenClaudeInstallProgress {
  step:    'checking' | 'init' | 'install' | 'done' | 'error'
  message: string
  percent: number
}

type ProgressFn = (p: OpenClaudeInstallProgress) => void

function push(win: BrowserWindow, p: OpenClaudeInstallProgress): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('openclaude:install-progress', p)
  }
}

function runNpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', err => reject(new Error(`npm spawn error: ${err.message}`)))
    proc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm ${args.join(' ')} exited ${code}: ${stderr.slice(-500)}`))
    })
  })
}

/**
 * Import the SDK entrypoint in a throwaway Node process — the same resolution
 * the sidecar performs at startup, run while we can still report it as an
 * install failure.
 *
 * Without this the only symptom of an unimportable tree is the sidecar exiting
 * 1 minutes later, on a code path that has no idea an install just happened.
 * This is deliberately a check on the RESULT, not on a known package list, so
 * the next upstream packaging surprise is caught whatever shape it takes.
 */
function verifySdkImports(cwd: string): Promise<void> {
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
  const probe =
    "import('@gitlawb/openclaude/sdk')" +
    ".then(m => { if (typeof m.query !== 'function') throw new Error('SDK loaded but exports no query()'); })" +
    '.catch(e => { console.error(e && (e.message || String(e))); process.exit(1) })'
  return new Promise((resolve, reject) => {
    const proc = spawn(nodeCmd, ['-e', probe], { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', err => reject(new Error(
      `Could not run Node to verify the OpenClaude install: ${err.message}. OpenClaude needs Node.js 22+ on PATH.`,
    )))
    proc.on('exit', code => {
      if (code === 0) { resolve(); return }
      reject(new Error(
        `OpenClaude installed but its SDK cannot be loaded: ${stderr.trim().split('\n')[0] ?? `node exited ${code}`}`,
      ))
    })
  })
}

// HTTP wrapper template — single source of truth for both first-time install
// and post-update wrapper refresh. SDK v0.13.0 takes a single-object param
// shape: `query({ prompt, options })`.
const WRAPPER_TEMPLATE = `
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import { query } from '@gitlawb/openclaude/sdk';

const PORT = parseInt(process.env.OPENCLAUDE_HTTP_PORT || process.env.GRPC_PORT || '50052', 10);

// ── PRIVATE MODE Tier 2: egress-policy denylist (DERIVED at build time) ──────
//
// The three constants below are NOT hand-written: they are interpolated from
// apps/desktop/electron/services/egress-policy.ts (the canonical policy) when
// WRAPPER_TEMPLATE is evaluated in the main process. The wrapper itself runs
// in a spawned Node sidecar and cannot import main-process modules at runtime
// — but the installer that GENERATES it can, so the policy has exactly one
// authoring site. (The previous hand-copied version drifted: it was missing
// 'browse' and 'deep_research'. Do not edit the generated file; edit
// egress-policy.ts and the next wrapper rewrite picks it up.)
//
// The current mode is supplied per-request via the /query POST body field
// 'privacyMode' (set by openclaude-client.ts from getCurrentPrivacyMode());
// the wrapper also honours the TACHI_PRIVACY_MODE env var as a startup-time
// fallback.
const NETWORK_TOOLS_DENIED_IN_PRIVATE = new Set(${JSON.stringify([...NETWORK_TOOLS_DENIED_IN_PRIVATE])});
const BASH_NETWORK_DENY = new RegExp(${JSON.stringify(BASH_NETWORK_DENY.source)}, ${JSON.stringify(BASH_NETWORK_DENY.flags)});
const BASH_INTERPRETER_EXFIL = new RegExp(${JSON.stringify(BASH_INTERPRETER_EXFIL.source)}, ${JSON.stringify(BASH_INTERPRETER_EXFIL.flags)});

function _privacyCheckToolEgress(mode, toolName) {
  if (mode !== 'private') return { allowed: true };
  if (NETWORK_TOOLS_DENIED_IN_PRIVATE.has(toolName)) {
    return {
      allowed: false,
      reason: 'PRIVATE MODE blocks network tool "' + toolName + '". Agents may only read/write within workspaceRoot and shell to local commands.',
    };
  }
  return { allowed: true };
}

// Mirrors matchesNetworkCommand() in egress-policy.ts: command-token network
// tools first, then interpreter one-liners (python -c / node -e …) that
// reference a network primitive.
function _privacyCheckBashCommandEgress(mode, command) {
  if (mode !== 'private') return { allowed: true };
  const match = command.match(BASH_NETWORK_DENY) || command.match(BASH_INTERPRETER_EXFIL);
  if (match) {
    return {
      allowed: false,
      reason: 'PRIVATE MODE blocks network shell commands. Detected: ' + match[0].trim().slice(0, 48),
    };
  }
  return { allowed: true };
}

// Upstream we proxy to. SDK's undici-based fetch consistently fails against
// Cloudflare-fronted endpoints (OpenGateway) with 'TypeError: terminated'.
// We expose /v1-proxy locally and rewrite OPENAI_BASE_URL to point here so
// the SDK's fetch hits localhost, and we forward upstream via node:https.
const UPSTREAM_BASE = process.env.UPSTREAM_OPENAI_BASE_URL || '';

// ── served-model sniffing (used by /v1-proxy below) ──────────────────────────
//
// How many bytes of a body we are willing to peek at before giving up. An
// OpenAI-compatible stream repeats the whole envelope — id/object/created/model
// — on EVERY SSE chunk, and a non-streamed answer carries "model" near the head
// of the JSON, so a few KB is already generous. The cap is the point of the
// thing: it is what keeps this a peek and stops it drifting into buffering the
// body, which would break streaming for every request to pay for a log line.
const SERVED_MODEL_PEEK_BYTES = 8192;

// Pull the first "model": "…" value out of a fragment of a response. This is
// deliberately a regex over text rather than JSON.parse: the fragment is a
// truncated prefix of a stream, and an SSE frame carries a "data: " prefix and
// a "[DONE]" sentinel, so it will not parse as JSON at all.
function _extractServedModel(text) {
  const m = text.match(/"model"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"/);
  if (!m) return null;
  // Re-parse the captured slice as a JSON string so an escaped id survives
  // intact; fall back to the raw capture rather than losing the answer.
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

// Accumulates at most limitBytes of a body and reports the model it names.
// Returns null — meaning UNKNOWN, and printed as such — when the cap is reached
// without a match. Never substitute the requested model as a default here: that
// guess would manufacture exactly the echo this whole mechanism exists to
// detect, and a confident wrong answer is worse than no answer.
//
// It concatenates before matching rather than testing each chunk on its own
// because a chunk boundary can fall inside the token ("mod | el":"x"), and a
// per-chunk match would silently miss it and report unknown. Re-decoding the
// accumulated prefix each time also self-heals a UTF-8 sequence split across
// two chunks.
function _createServedModelSniffer(limitBytes) {
  let chunks = [];
  let size = 0;
  let done = false;
  let found = null;
  return {
    feed(chunk) {
      if (done) return found;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buf);
      size += buf.length;
      found = _extractServedModel(Buffer.concat(chunks).toString('utf8'));
      if (found !== null || size >= limitBytes) { done = true; chunks = []; }
      return found;
    },
    result() { return found; },
  };
}

// Diagnostic banner — confirms env that SDK will actually see
console.log('[openclaude] boot', JSON.stringify({
  port: PORT,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI ?? null,
  OPENAI_BASE_URL:        process.env.OPENAI_BASE_URL ?? null,
  OPENAI_MODEL:           process.env.OPENAI_MODEL ?? null,
  UPSTREAM_OPENAI_BASE_URL: UPSTREAM_BASE || null,
  hasOpenAIKey:           !!process.env.OPENAI_API_KEY,
  hasAnthropicKey:        !!process.env.ANTHROPIC_API_KEY,
  TACHI_PRIVACY_MODE:     process.env.TACHI_PRIVACY_MODE ?? null,
}));

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Local proxy to upstream OpenAI-compat endpoint. SDK points OPENAI_BASE_URL
  // at http://127.0.0.1:<PORT>/v1-proxy. We forward via node:https because
  // SDK's fetch (undici) terminates the TLS connection against Cloudflare-
  // fronted hosts. Streaming bodies are forwarded chunk-by-chunk.
  if (req.url && req.url.startsWith('/v1-proxy')) {
    if (!UPSTREAM_BASE) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'UPSTREAM_OPENAI_BASE_URL not configured' }));
      return;
    }
    const upstreamPath = req.url.slice('/v1-proxy'.length) || '/';
    const upstream = new URL(UPSTREAM_BASE.replace(/\\/$/, '') + upstreamPath);

    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders['content-length'];
    delete forwardHeaders['accept-encoding'];

    // ── SERVED vs REQUESTED model ───────────────────────────────────────────
    //
    // Every model id the app records for an OpenClaude run is an ECHO of our own
    // request: the SDK stamps its events with the model variable it was handed
    // and never reads the "model" field the upstream response carries. So if a
    // gateway quietly answers with something other than what we asked for,
    // nothing in the run log, the cost ledger or the UI would ever show it —
    // they all trace back to the same request-side string. This proxy sees both
    // sides of the wire, which makes it the only place the substitution is
    // observable at all.
    //
    // The hard constraint: this must not become a buffering proxy. Both sniffers
    // PEEK at a bounded prefix of the bytes as they fly past and never touch,
    // copy back or re-serialise anything — the pipes below still carry the
    // original chunks unmodified. A proxy that alters the payload it observes is
    // worse than no proxy.
    const requestSniff = _createServedModelSniffer(SERVED_MODEL_PEEK_BYTES);

    console.log('[openclaude] v1-proxy →', req.method, upstream.href);
    const upstreamReq = httpsRequest({
      hostname: upstream.hostname,
      port:     upstream.port || 443,
      path:     upstream.pathname + upstream.search,
      method:   req.method,
      headers:  forwardHeaders,
    }, (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers['connection'];
      res.writeHead(upstreamRes.statusCode || 502, headers);

      // We strip accept-encoding on the way out so upstream should answer in
      // plain bytes, but an absent Accept-Encoding is not a ban — RFC 9110
      // §12.5.3 says any coding is acceptable when the field is missing — so a
      // gateway is still free to compress. Compressed bytes would hand the
      // regex below a plausible-looking rubbish id, so when the body is encoded
      // we do not sniff at all and the log says unknown.
      const enc = String(upstreamRes.headers['content-encoding'] || '').toLowerCase();
      const sniffable = enc === '' || enc === 'identity';
      const responseSniff = _createServedModelSniffer(SERVED_MODEL_PEEK_BYTES);

      // pipe() first, observer second. pipe is what actually moves the bytes; a
      // second 'data' listener only reads them. Both are attached in the same
      // synchronous turn, so no chunk can be emitted in between and the observer
      // cannot miss the head of the stream — which is the only part it wants.
      upstreamRes.pipe(res);
      if (sniffable) upstreamRes.on('data', (c) => { responseSniff.feed(c); });

      upstreamRes.on('end', () => {
        // By now the request body has been fully written, so the request-side
        // peek is complete too. null prints as unknown; it is never filled in.
        const requested = requestSniff.result();
        const served    = sniffable ? responseSniff.result() : null;
        console.log(
          '[openclaude] v1-proxy ← status=' + upstreamRes.statusCode +
          ' requestedModel=' + (requested === null ? 'unknown' : requested) +
          ' servedModel='    + (served    === null ? 'unknown' : served),
        );
        // Not necessarily an error: a gateway may legitimately resolve an alias
        // to a pinned or dated id. It is still the only evidence that what ran
        // is not what was asked for, so it gets its own line instead of being
        // lost at the end of the one above.
        if (requested !== null && served !== null && requested !== served) {
          console.warn(
            '[openclaude] v1-proxy MODEL SUBSTITUTION requested=' + requested + ' served=' + served,
          );
        }
      });
    });
    upstreamReq.setTimeout(120000, () => {
      console.error('[openclaude] v1-proxy timeout');
      upstreamReq.destroy(new Error('upstream timeout'));
    });
    upstreamReq.on('error', (e) => {
      console.error('[openclaude] v1-proxy error', e && (e.message || String(e)));
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream error: ' + String(e) }));
      } else {
        res.end();
      }
    });
    // Attached immediately before the pipe, in the same synchronous turn, for
    // the same reason as the response side: adding a 'data' listener resumes the
    // stream, and nothing may run between resuming it and connecting the pipe.
    req.on('data', (c) => { requestSniff.feed(c); });
    req.pipe(upstreamReq);
    return;
  }

  // Pre-flight: probe the OpenAI-compat endpoint directly to surface auth/model
  // errors that the SDK would otherwise swallow in silent retry loops.
  // Uses node:https (not fetch/undici) because OpenGateway/Cloudflare consistently
  // breaks undici with 'TypeError: terminated' while node:https works fine.
  if (req.method === 'GET' && req.url === '/preflight') {
    const base  = process.env.OPENAI_BASE_URL;
    const key   = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || ${JSON.stringify(OPENGATEWAY_AGENT_MODEL)};
    if (!base || !key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OPENAI_BASE_URL or OPENAI_API_KEY missing' }));
      return;
    }
    try {
      const u = new URL(base + '/chat/completions');
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
      const { request: httpsRequest } = await import('node:https');
      const result = await new Promise((resolve, reject) => {
        const r = httpsRequest({
          hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
          method: 'POST', headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + key,
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'application/json',
            'User-Agent': 'tachi-studio/0.1 (node-https)',
          },
        }, (rr) => {
          let buf = '';
          rr.setEncoding('utf8');
          rr.on('data', d => { buf += d; });
          rr.on('end', () => resolve({ status: rr.statusCode, body: buf }));
        });
        r.setTimeout(20000, () => { r.destroy(new Error('preflight timeout')); });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
      console.log('[openclaude] preflight (node:https)', result.status, String(result.body).slice(0, 300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: result.status, body: String(result.body).slice(0, 500), keyPrefix: key.slice(0, 8), model, base }));
    } catch (e) {
      console.error('[openclaude] preflight error', e && (e.message || String(e)));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/query') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const { prompt, cwd, model, env: extraEnv, sessionId, resume } = payload;
      // PRIVATE MODE: per-request mode from caller (openclaude-client.ts), falling
      // back to TACHI_PRIVACY_MODE env at spawn time, then 'open'. Per-request wins
      // so a mid-session privacy toggle takes effect on the very next turn without
      // needing to restart the sidecar.
      const privacyMode = (payload.privacyMode === 'private' || payload.privacyMode === 'open')
        ? payload.privacyMode
        : (process.env.TACHI_PRIVACY_MODE === 'private' ? 'private' : 'open');
      // PRIVATE MODE Tier 4: per-request capability mode forwarded by the
      // host. We DON'T gate on it inside this wrapper — user approval is
      // intercepted upstream in agent.ipc.ts (tool-call event is held until
      // capabilityService.awaitDecision resolves). This is purely diagnostic
      // so /query logs reflect which path the host is using.
      const capabilityMode = (payload.capabilityMode === 'inbox' || payload.capabilityMode === 'immediate')
        ? payload.capabilityMode
        : 'immediate';
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'prompt is required' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      });
      const ac = new AbortController();
      // Use res.on('close') NOT req.on('close') — in Node.js HTTP, req emits 'close'
      // as soon as the request body has been fully read, which happens immediately
      // after req.on('end') fires.  Attaching ac.abort() there would cancel the SDK
      // before it can make any LLM calls.  res.on('close') fires only when the actual
      // TCP connection to the client drops, which is the correct abort signal.
      res.on('close', () => ac.abort());
      console.log('[openclaude] /query received', JSON.stringify({
        promptLen: typeof prompt === 'string' ? prompt.length : -1,
        cwd: cwd ?? null,
        model: model ?? process.env.OPENAI_MODEL ?? null,
        sessionId: sessionId ?? null,
        resume: resume ?? null,
        privacyMode,
        capabilityMode,
      }));

      // Resolve the workspace root once — used for chdir AND sandbox validation.
      // Normalise so that path.relative comparisons work regardless of whether
      // the caller passes a trailing slash.
      const workspaceRoot = (cwd && typeof cwd === 'string') ? path.resolve(cwd) : null;

      // Guard: if the requested workspace doesn't exist, refuse the query so
      // the agent never starts in an undefined directory.
      if (workspaceRoot) {
        try {
          const stat = fs.statSync(workspaceRoot);
          if (!stat.isDirectory()) {
            console.error('[openclaude-sandbox] workspace path is not a directory:', workspaceRoot);
            res.write(JSON.stringify({ type: 'error', error: \`Workspace is not a directory: \${workspaceRoot}\` }) + '\\n');
            res.end();
            return;
          }
        } catch {
          console.error('[openclaude-sandbox] workspace does not exist:', workspaceRoot);
          res.write(JSON.stringify({ type: 'error', error: \`Workspace directory does not exist: \${workspaceRoot}\` }) + '\\n');
          res.end();
          return;
        }
      }

      const sidecarPrevCwd = process.cwd();
      if (workspaceRoot) {
        try {
          process.chdir(workspaceRoot);
          console.log('[openclaude] chdir →', workspaceRoot);
        } catch (e) {
          console.warn('[openclaude] chdir failed:', e && (e.message || String(e)));
        }
      }

      // System prompt preamble injected at the top of every query so the agent
      // always knows its workspace root — even if the SDK's internal shell-cwd
      // tracking drifts after an aborted Bash tool.
      const workspaceSystemPrompt = workspaceRoot
        ? \`WORKSPACE_ROOT: \${workspaceRoot}\\nYou are working inside WORKSPACE_ROOT. All file paths you create or modify MUST be inside this directory. If the shell cwd is reported as something outside WORKSPACE_ROOT, ASSUME WORKSPACE_ROOT and use absolute paths under it. DO NOT write to the user's home directory or any path outside WORKSPACE_ROOT.\\n\\n\`
        : '';

      // PRIVATE MODE preamble — tells the model up-front what is blocked so it
      // does not waste turns attempting denied tools/commands. Appended after
      // the workspace preamble so both contexts are present.
      const privacySystemPrompt = privacyMode === 'private'
        ? \`PRIVACY_MODE: private\\nYou are in PRIVATE MODE. You MUST NOT use ${[...NETWORK_TOOLS_DENIED_IN_PRIVATE].join(', ')}, or any shell command that touches the network (curl, wget, nc, netcat, ssh, scp, rsync, aria2c, axel, fetch, iwr, Invoke-WebRequest, Invoke-RestMethod, certutil, bitsadmin). If you need information not available locally, tell the user explicitly that PRIVATE MODE blocks it instead of attempting and getting denied.\\n\\n\`
        : '';

      let _msgCount = 0;
      try {
        const messages = query({
          prompt: workspaceSystemPrompt + privacySystemPrompt + prompt,
          options: {
            cwd: workspaceRoot || process.cwd(),
            abortController: ac,
            // PERMISSION POSTURE — 'default', deliberately NOT 'bypassPermissions'.
            //
            // 0.27.0 made both dangerous modes ('bypassPermissions', 'fullAccess')
            // throw unless the caller ALSO passes allowDangerouslySkipPermissions:
            // true (buildPermissionContext in dist/sdk.mjs). Live on 2026-08-02 that
            // killed every first query with
            //   SDK permissionMode "bypassPermissions" requires allowDangerouslySkipPermissions: true
            // The message names a flag; setting it is the wrong reading. What the
            // upstream change actually did is force the embedder to state, once,
            // which posture it wants — and the honest answer here is the LEAST one
            // that lets the agent work.
            //
            // Read from the installed bundle, not assumed: when canUseTool is
            // supplied, createExternalCanUseTool consults it FIRST and its verdict is
            // final — resolveHookPermissionDecision (the single tool gate) ends at
            // canUseTool for every tool, and the rule/safety machinery it can reach
            // (checkRuleBasedPermissions / checkPlanModePermissions) is inert outside
            // plan mode. So in 'default' mode THIS callback is the whole permission
            // authority; nothing is auto-allowed by virtue of the mode. That is
            // exactly the behaviour the old flag was reaching for, minus the
            // declaration that we want the guardrails off.
            //
            // 'bypassPermissions' additionally makes hasPermissionsToUseTool
            // short-circuit to allow and lets speculative write auto-accept run — i.e.
            // it can only ever ALLOW more than we do here, never less. 'dontAsk' would
            // deny anything not pre-approved (no pre-approvals exist here → dead
            // agent), and 'fullAccess' also strips hard safety checks. Do not "fix" a
            // future permission error by widening this; widen the callback below, in
            // the open, one rule at a time.
            //
            // What the callback enforces today: PRIVATE-MODE egress (tools + shell
            // commands, denylists derived from egress-policy.ts) and a workspace
            // sandbox on Write/Edit/MultiEdit. Everything else is allowed because the
            // user picked the folder and started the run.
            permissionMode: 'default',
            canUseTool: async (toolName, toolInput) => {
              // ── PRIVATE MODE: deny network tools outright ──────────────
              // Keep denylists in sync with apps/desktop/electron/services/egress-policy.ts.
              const toolEgress = _privacyCheckToolEgress(privacyMode, toolName);
              if (!toolEgress.allowed) {
                console.error('[openclaude-private]', toolEgress.reason);
                return { behavior: 'deny', message: toolEgress.reason };
              }

              // Re-assert cwd before every Bash/Shell tool in case the SDK's
              // internal state was reset by a prior abort.
              if (toolName === 'Bash' || toolName === 'Shell') {
                // PRIVATE MODE: deny network-touching shell commands.
                const cmd = (toolInput && typeof toolInput['command'] === 'string')
                  ? toolInput['command']
                  : '';
                const bashEgress = _privacyCheckBashCommandEgress(privacyMode, cmd);
                if (!bashEgress.allowed) {
                  console.error('[openclaude-private]', bashEgress.reason);
                  return { behavior: 'deny', message: bashEgress.reason };
                }
                if (workspaceRoot) {
                  try { process.chdir(workspaceRoot); } catch { /* ignore */ }
                }
                return { behavior: 'allow' };
              }

              // Sandbox: reject writes that would escape the workspace.
              if (workspaceRoot && (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit')) {
                const rawPath = toolInput['file_path'] || toolInput['path'];
                if (rawPath && typeof rawPath === 'string') {
                  const targetPath = path.resolve(workspaceRoot, rawPath);
                  const rel = path.relative(workspaceRoot, targetPath);
                  if (rel.startsWith('..') || path.isAbsolute(rel)) {
                    const msg = \`Write rejected: path "\${targetPath}" is outside workspace "\${workspaceRoot}". Use paths inside the workspace.\`;
                    console.error('[openclaude-sandbox]', msg);
                    return { behavior: 'deny', message: msg };
                  }
                }
                return { behavior: 'allow' };
              }

              return { behavior: 'allow' };
            },
            // Stream token-by-token text deltas for "live thinking" UX.
            includePartialMessages: true,
            // Use payload model if given; otherwise fall back to the env-var model
            // configured by sidecar-manager (OPENGATEWAY_AGENT_MODEL for
            // OpenGateway, 'auto' for freellmapi).  Without this fallback the SDK defaults to
            // claude-3-5-sonnet which the OpenAI-compat endpoint doesn't recognise.
            ...(model
              ? { model }
              : (process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {})),
            ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
            // Session continuity: resume a prior SDK conversation when the caller
            // supplies its SDK session_id from a previous init event.
            ...(sessionId ? { sessionId } : {}),
            ...(resume    ? { resume }    : {}),
          },
        });
        for await (const msg of messages) {
          if (ac.signal.aborted) break;
          _msgCount++;
          console.log('[openclaude] msg', _msgCount, msg && msg.type, (msg && msg.subtype) || '');
          // The SDK's init/system event already carries session_id (see
          // buildSystemInitMessage in sdk.mjs). The client picks it up from
          // msg.session_id directly — no synthetic line needed.
          res.write(JSON.stringify(msg) + '\\n');
        }
        console.log('[openclaude] /query loop done, msgs=' + _msgCount);
      } catch (err) {
        console.error('[openclaude] /query error:', err && (err.stack || err.message || String(err)));
        if (!ac.signal.aborted) {
          res.write(JSON.stringify({ type: 'error', error: String(err) }) + '\\n');
        }
      } finally {
        // Restore the sidecar's cwd so the next /query (which may target a
        // different workspace) starts from a known-good baseline.
        try { process.chdir(sidecarPrevCwd); } catch { /* ignore */ }
        res.end();
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('openclaude HTTP server listening on port ' + PORT);
});
`.trim()

let activeInstall: Promise<void> | null = null

export function installOpenClaude(win: BrowserWindow): Promise<void> {
  if (activeInstall) return activeInstall
  activeInstall = _doInstall(win)
    .catch((err: unknown) => {
      // Report the failure on the SAME channel as progress, so the install UI
      // shows the reason instead of freezing at whatever percent it reached.
      // Centralised here (not in openclaude.ipc.ts) because agent.ipc.ts calls
      // installOpenClaude() directly on the first-run path — the exact path
      // that broke on 2026-08-02 — and never went through that handler.
      const message = err instanceof Error ? err.message : String(err)
      push(win, { step: 'error', message, percent: 0 })
      throw err
    })
    .finally(() => { activeInstall = null })
  return activeInstall
}

/**
 * Write (or overwrite) the HTTP wrapper script. Idempotent.
 * Called on every startOpenClaude() so users with older wrapper code
 * (e.g. from before the SDK signature change) get healed automatically.
 */
export function writeOpenClaudeWrapper(): void {
  const dir = openclaudeBase()
  if (!existsSync(dir)) return   // nothing installed yet; full install path will handle it

  writeFileSync(join(dir, 'start-server.mjs'), WRAPPER_TEMPLATE, 'utf8')

  // Clean up the legacy gRPC wrapper if it survived from a pre-HTTP install.
  const legacy = join(dir, 'start-grpc.mjs')
  if (existsSync(legacy)) {
    try { unlinkSync(legacy) } catch { /* non-fatal */ }
  }
}

async function _doInstall(win: BrowserWindow): Promise<void> {
  const dir = openclaudeBase()
  push(win, { step: 'checking', message: 'Checking…', percent: 0 })

  mkdirSync(dir, { recursive: true })

  push(win, { step: 'init', message: 'Initialising package directory…', percent: 20 })
  if (!existsSync(join(dir, 'package.json'))) {
    await runNpm(['init', '-y'], dir)
  }

  push(win, { step: 'install', message: `Installing @gitlawb/openclaude@${OPENCLAUDE_SDK_VERSION} (may take a minute)…`, percent: 40 })
  // ONE npm call for the SDK and its statically-imported peers: npm will not
  // install optional peerDependencies on its own, and dist/sdk.mjs imports them
  // at the top level (see OPENCLAUDE_REQUIRED_PEERS). Installing them in the
  // same resolution keeps the tree consistent and costs one round trip.
  const peerSpecs = Object.entries(OPENCLAUDE_REQUIRED_PEERS).map(([n, v]) => `${n}@${v}`)
  await runNpm(['install', `@gitlawb/openclaude@${OPENCLAUDE_SDK_VERSION}`, ...peerSpecs], dir)

  // Prove the tree is loadable NOW, while the failure can still be reported as
  // an install error naming the missing package — the whole point of the
  // 2026-08-02 breakage was that this only showed up as sidecar "exit code 1".
  push(win, { step: 'install', message: 'Verifying the SDK loads…', percent: 75 })
  await verifySdkImports(dir)

  // NOTE: no post-install monkey-patch of dist/sdk.mjs any more. patchSdkMjs()
  // used to no-op `SandboxManager.annotateStderrWithSandboxFailures(...)`,
  // which threw on the 0.13.x–0.15.x non-sandbox platform stub and broke every
  // Bash tool result. Upstream fixed exactly that in 0.16.0 ("sandbox: guard
  // annotateStderrWithSandboxFailures against missing runtime method", #1452)
  // and ships a real sandbox runtime since 0.19.0 — so at any pin >= 0.16.0
  // the regex patch could only corrupt a healthy bundle (a partial match would
  // write broken JS and kill the sidecar at import). If the pin is ever rolled
  // back below 0.16.0, restore patchSdkMjs() from git history (removed
  // 2026-08-01 with the 0.15.0 → 0.27.0 bump).

  push(win, { step: 'install', message: 'Writing HTTP server wrapper…', percent: 85 })
  writeOpenClaudeWrapper()

  push(win, { step: 'done', message: 'OpenClaude ready.', percent: 100 })
}
