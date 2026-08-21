// packages/core/src/design/remotion.ts
//
// Animation mode for the Design tab (referencing remotion.dev). Remotion is React
// + frame-based interpolation (CSS animations are FORBIDDEN in it — they don't
// render deterministically). We let the model write ONLY a composition module,
// then wrap it in a known-good HTML scaffold that mounts Remotion's web <Player>
// from a CDN (React/remotion/@remotion/player via esm.sh, JSX transpiled by Babel
// standalone). The scaffold runs in the SAME sandboxed iframe as static designs,
// so untrusted generated code never reaches the renderer.
//
// Phase 1 = live in-app preview. MP4 export (the headless @remotion/renderer) is
// a later phase; the composition code we keep makes that drop-in.
//
// Pure + renderer-safe (no I/O), so it unit-tests and imports via the
// `@tachi/core/src/design/...` subpath.

import { DESIGN_SCAFFOLD_MARK } from './scaffold.js'

/** Globals the scaffold puts in scope for the composition (so it needs no imports). */
export const REMOTION_GLOBALS = [
  'React', 'useCurrentFrame', 'useVideoConfig', 'interpolate', 'spring',
  'Sequence', 'Series', 'AbsoluteFill', 'Easing', 'Img', 'random', 'interpolateColors', 'staticFile',
  'Audio', 'Video', 'OffthreadVideo',
]

/** System prompt for animation mode: emit ONE Remotion composition module.
 *  `audioFiles` = bare filenames in the user's design-audio dir (voiceover /
 *  SFX) — when present, the contract teaches <Audio src={staticFile(...)}>
 *  and PINS the model to exactly these names (silent-failure risk otherwise). */
export function buildAnimationSystemPrompt(opts: { context?: string; brief?: string; audioFiles?: string[] } = {}): string {
  const parts = [
    `You are a motion designer who writes Remotion (remotion.dev) animations — React rendered frame-by-frame.`,
    ``,
    `OUTPUT CONTRACT (strict):`,
    `- Reply with EXACTLY ONE code block — a single \`\`\`tsx fenced block — and NOTHING else (no prose).`,
    `- Do NOT write any import statements. These are already in scope as globals: ${REMOTION_GLOBALS.join(', ')}.`,
    `- Define a root React component named EXACTLY \`Composition\`, and a \`const config = { durationInFrames, fps, width, height }\`.`,
    `- Animate EVERYTHING with useCurrentFrame() + interpolate()/spring(). CSS transitions/animations and @keyframes are FORBIDDEN — they will not render. Tailwind animate-* classes are FORBIDDEN.`,
    `- Use <AbsoluteFill> for layers and <Sequence from=… durationInFrames=…> for timing. Use Easing.bezier(...) for natural motion.`,
    `- Inline all styles via the React \`style\` prop. Self-contained: no local assets except media the user explicitly names (via staticFile); only https URLs inside <Img>/<Audio>/<Video> if truly needed.`,
    `- Output the COMPLETE module — never abbreviate, truncate, or use "…" / "/* ... */". Even if the user attaches an image or lots of text, reply with ONLY the single \`\`\`tsx block (the root component MUST be named exactly \`Composition\`).`,
    ``,
    `REMOTION RULES (from Remotion's official AI skill — follow exactly for correct rendering):`,
    `- Prefer interpolate() for animation; use spring({ fps, frame, config }) ONLY when you want physics (bounce/settle). Default is interpolate() + Easing.bezier(...).`,
    `- ALWAYS clamp: every interpolate() must pass { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } so values never shoot past their range.`,
    `- Prefer individual style props (scale, rotate, translate) over composing one big \`transform\` string.`,
    `- Read fps/width/height from useVideoConfig() — never hardcode them inside a component.`,
    `- Assets: <Img src={staticFile('x.png')} /> (file in public/) or a direct https URL. CSS transitions/animations/@keyframes and Tailwind animate-* are FORBIDDEN — they do not render.`,
    `- SOUND: <Audio src=…> (and <Video>/<OffthreadVideo> for footage) mux natively into the MP4 export. Allowed sources ONLY: a direct https audio URL, or a local file the user EXPLICITLY names (e.g. a synthesized voiceover) — reference those as src={staticFile('vo.wav')}. NEVER invent local filenames; if no sound was requested or provided, use no <Audio>. Time audio with <Sequence from=…>, trim with startFrom/endAt (frames), set volume (0–1).`,
    `- Size for VIDEO (1280×720+): large, legible type and bold hierarchy — not webpage-sized text.`,
    ``,
    `MOTION-DESIGN CRAFT (this is what separates designed work from generic output — apply it):`,
    `- TIMING/EASING: never linear. Entrances ease OUT (decelerate): Easing.bezier(0.16, 1, 0.3, 1). Exits ease IN. For organic, weighty motion use spring({fps, frame, config:{damping:200}}) — and tune damping/mass/stiffness for the feel (snappy vs soft).`,
    `- STAGGER: animate elements in sequence, offset by 2–5 frames (frame - i*3), never all at once. This is the #1 thing that reads as "designed".`,
    `- THE 12 PRINCIPLES: use anticipation (small counter-move before the main move), overshoot/settle (go past then back), follow-through & secondary motion (trailing parts lag), and ease/spacing. Add subtle continuous drift/parallax so nothing sits dead still.`,
    `- STRUCTURE: a clear arc — IN (entrance), HOLD (let it breathe — don't rush), OUT (resolve). Pace it; leave hold frames. Loop cleanly if looping.`,
    `- COMPOSITION: strong focal hierarchy, intentional negative space, depth via layered scale/blur/parallax. A confident, cohesive limited palette. Real type pairing, big and tight for display.`,
    `- PALETTE: commit to ONE distinctive accent fit to the subject. BANNED (reads as AI-generated): the purple/indigo + cyan/teal gradient on near-black, mesh/blob gradients. Pick a scheme with a real point of view instead (editorial red, acid lime, amber, deep teal, signal orange, electric blue, oxblood…). Off-black/off-white, never pure values.`,
    `- POLISH: tasteful glow/gradient/grain/vignette, soft shadows, motion-blur feel via scale+opacity on fast moves. Restraint over clutter.`,
    `- ANTI-PATTERNS to AVOID: everything fading in together; linear easing; one element centered with nothing else; static after entrance (add life); default fonts; muddy colors; overusing particles as a crutch; no hold time.`,
    ``,
    `Example shape (note the eased, staggered entrance):`,
    `\`\`\`tsx`,
    `const Title = () => {`,
    `  const frame = useCurrentFrame(); const { fps } = useVideoConfig();`,
    `  const opacity = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });`,
    `  return <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', background: '#0a0a0a' }}>`,
    `    <h1 style={{ opacity, color: '#fff', fontSize: 90 }}>Hello</h1>`,
    `  </AbsoluteFill>;`,
    `};`,
    `const Composition = () => <Title />;`,
    `const config = { durationInFrames: 120, fps: 30, width: 1280, height: 720 };`,
    `\`\`\``,
  ]
  const audio = (opts.audioFiles ?? []).filter(f => typeof f === 'string' && f.trim())
  if (audio.length > 0) {
    parts.push(
      ``,
      `AUDIO — these files exist in the project and are the ONLY audio you may reference:`,
      ...audio.map(f => `- staticFile('${f}')`),
      `- Score the animation with <Audio src={staticFile('…')} /> (wrap in <Sequence from={…}> to time it; volume={0–1} to mix).`,
      `- NEVER invent an audio filename or use an external audio URL — a missing file fails the render silently.`,
    )
  }
  if (opts.brief && opts.brief.trim()) {
    parts.push(``, `ART DIRECTION — implement this EXACTLY (chosen for this request):`, opts.brief.trim())
  }
  if (opts.context && opts.context.trim()) {
    parts.push(``, `CONTEXT — animate for this project/brand:`, opts.context.trim())
  }
  return parts.join('\n')
}

/**
 * Pull the composition code out of a model reply. Collects ALL fenced blocks and
 * prefers the largest one that actually defines `Composition`, so prose, multiple
 * blocks, or a stray earlier snippet don't break extraction; falls back to the
 * largest block, then raw text.
 */
export function extractCompositionCode(reply: string): string {
  if (!reply) return ''
  const text = reply.replace(/\r\n/g, '\n')
  const blocks: string[] = []
  const re = /```(?:tsx|jsx|ts|js)?\s*\n([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) if (m[1].trim()) blocks.push(m[1].trim())
  // Truncated reply (output limit / dropped stream): an UNTERMINATED trailing
  // fence still holds the module — without this a reply cut mid-code yielded
  // zero usable blocks and the whole build failed.
  if ((text.match(/```/g) || []).length % 2 === 1) {
    const tail = text.slice(text.lastIndexOf('```')).replace(/^```[^\n]*\n?/, '').trim()
    if (tail) blocks.push(tail)
  }
  if (blocks.length === 0) return text.trim()
  const withComposition = blocks.filter(b => /\bComposition\b/.test(b))
  const pool = withComposition.length > 0 ? withComposition : blocks
  return pool.reduce((a, b) => (b.length > a.length ? b : a))
}

/** Strip imports + export keywords so the composition runs inside the scaffold's module scope. */
export function sanitizeComposition(code: string): string {
  return code
    .split('\n')
    .filter(l => !/^\s*import\s/.test(l))
    .join('\n')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+(const|let|var|function|class|async)\b/gm, '$1')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .trim()
}

/**
 * Wrap a composition module in a self-contained HTML page that mounts Remotion's
 * <Player>. Loads React/remotion/@remotion/player from esm.sh (deduped React via
 * ?external) and transpiles JSX/TS with Babel standalone. Renders in the sandboxed
 * iframe; surfaces any load/runtime error inside the frame for visibility.
 */
// Known-good versions (verified together in claude-design/promo): React 19.2.3 +
// Remotion 4.0.475. Pinning an older Remotion (e.g. 4.0.0) against React 19 throws
// internally and the browser masks it as "Script error." — so keep these aligned.
const V = { react: '19.2.3', remotion: '4.0.475' }

export function buildRemotionHtml(compositionCode: string): string {
  const code = sanitizeComposition(compositionCode)
  return `<!doctype html>${DESIGN_SCAFFOLD_MARK}
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>html,body{margin:0;height:100%;background:#0a0a0a;overflow:hidden}#root{height:100vh;display:flex;align-items:center;justify-content:center;color:#888;font:13px/1.5 monospace}#err{color:#ff6b6b;padding:16px;white-space:pre-wrap;max-width:92vw;overflow:auto;max-height:92vh}</style>
<script type="importmap">
{"imports":{
"react":"https://esm.sh/react@${V.react}",
"react/jsx-runtime":"https://esm.sh/react@${V.react}/jsx-runtime",
"react-dom":"https://esm.sh/react-dom@${V.react}",
"react-dom/client":"https://esm.sh/react-dom@${V.react}/client",
"remotion":"https://esm.sh/remotion@${V.remotion}?external=react,react-dom",
"remotion/no-react":"https://esm.sh/remotion@${V.remotion}/no-react?external=react,react-dom",
"remotion/":"https://esm.sh/remotion@${V.remotion}/",
"@remotion/player":"https://esm.sh/@remotion/player@${V.remotion}?external=react,react-dom,remotion",
"@remotion/player/":"https://esm.sh/@remotion/player@${V.remotion}/"
}}
</script>
</head>
<body>
<div id="root">loading Remotion…</div>
<script>
window.__show=function(m){var r=document.getElementById('root');if(r){r.innerHTML='<pre id="err">'+String(m)+'</pre>';}};
window.addEventListener('error',function(e){window.__show((e&&(e.error&&(e.error.stack||e.error.message)||e.message))||'load error');});
window.addEventListener('unhandledrejection',function(e){window.__show((e&&e.reason&&(e.reason.stack||e.reason.message))||(e&&e.reason)||'promise rejection');});
// The sandboxed iframe (no allow-same-origin) has an OPAQUE origin, so
// window.origin === "null" — and remotion's getAbsoluteSrc() does
// new URL(src, window.origin), which THROWS for any <Audio>/<Video>/<Img>
// src (the Player then blanks the whole composition with its ⚠ fallback).
// Shim origin from the document URL (tachi-preview://doc) so media resolves.
try{var __u=new URL(location.href);var __org=__u.protocol+'//'+__u.host;Object.defineProperty(window,'origin',{get:function(){return __org},configurable:true});}catch(e){}
</script>
<script type="text/babel" data-type="module" data-presets="react,typescript">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Player } from '@remotion/player'
import * as Remotion from 'remotion'
const { useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Series, AbsoluteFill, Easing, Img, random, interpolateColors, staticFile, Audio, Video, OffthreadVideo } = Remotion

${code}

class __EB extends React.Component {
  constructor(p){ super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err){ window.__show(err && (err.stack || err.message) || err); }
  render(){ return this.state.err ? null : this.props.children; }
}

try {
  const __cfg = (typeof config !== 'undefined' ? config : {})
  createRoot(document.getElementById('root')).render(
    React.createElement(__EB, null,
      React.createElement(Player, {
        component: Composition,
        durationInFrames: __cfg.durationInFrames || 150,
        fps: __cfg.fps || 30,
        compositionWidth: __cfg.width || 1280,
        compositionHeight: __cfg.height || 720,
        controls: true, autoPlay: true, loop: true,
        acknowledgeRemotionLicense: true,
        // Player pre-mounts 5 shared <audio> tags by default and THROWS if a
        // composition mounts a 6th simultaneous <Audio> (SFX-heavy scenes hit
        // this mid-playback). Raise the pool well past any sane composition.
        numberOfSharedAudioTags: 32,
        errorFallback: function(p){ return React.createElement('div', { style: { position: 'absolute', inset: 0, background: '#0a0a0a', color: '#ff6b6b', font: '12px/1.6 monospace', padding: 16, overflow: 'auto', whiteSpace: 'pre-wrap' } }, 'Composition error:\\n' + ((p && p.error && (p.error.stack || p.error.message)) || String(p && p.error))) },
        style: { width: '100%', height: '100%' },
      })
    )
  )
} catch (e) { window.__show(e && (e.stack || e.message) || e) }
</script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
</body>
</html>`
}

/**
 * Fast path: like buildRemotionHtml, but takes ALREADY-COMPILED JS (classic-JSX →
 * React.createElement, types stripped, no import statements) and emits a
 * Babel-FREE ES-module page. Transpiling in the main process (see
 * design-generate.ts → compileComposition) removes the ~3 MB @babel/standalone
 * download + in-browser transpile that made the live preview slow to load — the
 * dominant cost. Pure / renderer-safe (string templating only).
 */
export function buildRemotionHtmlFromJs(compiledJs: string): string {
  return `<!doctype html>${DESIGN_SCAFFOLD_MARK}
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>html,body{margin:0;height:100%;background:#0a0a0a;overflow:hidden}#root{height:100vh;display:flex;align-items:center;justify-content:center;color:#888;font:13px/1.5 monospace}#err{color:#ff6b6b;padding:16px;white-space:pre-wrap;max-width:92vw;overflow:auto;max-height:92vh}</style>
<script type="importmap">
{"imports":{
"react":"https://esm.sh/react@${V.react}",
"react/jsx-runtime":"https://esm.sh/react@${V.react}/jsx-runtime",
"react-dom":"https://esm.sh/react-dom@${V.react}",
"react-dom/client":"https://esm.sh/react-dom@${V.react}/client",
"remotion":"https://esm.sh/remotion@${V.remotion}?external=react,react-dom",
"remotion/no-react":"https://esm.sh/remotion@${V.remotion}/no-react?external=react,react-dom",
"remotion/":"https://esm.sh/remotion@${V.remotion}/",
"@remotion/player":"https://esm.sh/@remotion/player@${V.remotion}?external=react,react-dom,remotion",
"@remotion/player/":"https://esm.sh/@remotion/player@${V.remotion}/"
}}
</script>
</head>
<body>
<div id="root">loading Remotion…</div>
<script>
window.__show=function(m){var r=document.getElementById('root');if(r){r.innerHTML='<pre id="err">'+String(m)+'</pre>';}};
window.addEventListener('error',function(e){window.__show((e&&(e.error&&(e.error.stack||e.error.message)||e.message))||'load error');});
window.addEventListener('unhandledrejection',function(e){window.__show((e&&e.reason&&(e.reason.stack||e.reason.message))||(e&&e.reason)||'promise rejection');});
// Same opaque-origin shim as buildRemotionHtml — without it remotion's
// getAbsoluteSrc (new URL(src, window.origin)) throws in the sandboxed iframe
// for any <Audio>/<Video>/<Img> and the Player blanks the composition.
try{var __u=new URL(location.href);var __org=__u.protocol+'//'+__u.host;Object.defineProperty(window,'origin',{get:function(){return __org},configurable:true});}catch(e){}
</script>
<script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Player } from '@remotion/player'
import * as Remotion from 'remotion'
const { useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Series, AbsoluteFill, Easing, Img, random, interpolateColors, staticFile, Audio, Video, OffthreadVideo } = Remotion

${compiledJs}

class __EB extends React.Component {
  constructor(p){ super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err){ window.__show(err && (err.stack || err.message) || err); }
  render(){ return this.state.err ? null : this.props.children; }
}

try {
  const __cfg = (typeof config !== 'undefined' ? config : {})
  createRoot(document.getElementById('root')).render(
    React.createElement(__EB, null,
      React.createElement(Player, {
        component: Composition,
        durationInFrames: __cfg.durationInFrames || 150,
        fps: __cfg.fps || 30,
        compositionWidth: __cfg.width || 1280,
        compositionHeight: __cfg.height || 720,
        controls: true, autoPlay: true, loop: true,
        acknowledgeRemotionLicense: true,
        // Same as buildRemotionHtml: default shared-audio pool is 5 and the
        // Player throws on the 6th simultaneous <Audio> — raise it.
        numberOfSharedAudioTags: 32,
        errorFallback: function(p){ return React.createElement('div', { style: { position: 'absolute', inset: 0, background: '#0a0a0a', color: '#ff6b6b', font: '12px/1.6 monospace', padding: 16, overflow: 'auto', whiteSpace: 'pre-wrap' } }, 'Composition error:\\n' + ((p && p.error && (p.error.stack || p.error.message)) || String(p && p.error))) },
        style: { width: '100%', height: '100%' },
      })
    )
  )
} catch (e) { window.__show(e && (e.stack || e.message) || e) }
</script>
</body>
</html>`
}

/**
 * Wrap a generated composition module in a real Remotion ENTRY file that
 * `@remotion/bundler` can webpack for server-side MP4 export. Unlike the preview
 * scaffolds above (which mount the web <Player> in a sandboxed iframe), this is a
 * proper module: it imports React + the Remotion globals + registerRoot, inlines
 * the (sanitized, import-free) composition, and registers ONE <Composition> whose
 * dimensions/duration come from the generated `config`. `@remotion/renderer` then
 * `selectComposition({ id })` + `renderMedia()` against the bundle.
 *
 * The generated root component is named exactly `Composition` (per the animation
 * prompt contract), so Remotion's own `Composition` registration element is
 * imported aliased as `RemotionComposition`. Pure string templating — no I/O — so
 * it unit-tests; the caller writes the returned source to a temp entry file.
 */
export function buildRemotionEntry(compositionCode: string, id = 'design'): string {
  const code = sanitizeComposition(compositionCode)
  return `import React from 'react';
import { registerRoot, Composition as RemotionComposition, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Series, AbsoluteFill, Easing, Img, random, interpolateColors, staticFile, Audio, Video, OffthreadVideo } from 'remotion';

${code}

const __cfg = (typeof config !== 'undefined' ? config : {});
const RemotionRoot = () => React.createElement(RemotionComposition, {
  id: ${JSON.stringify(id)},
  component: Composition,
  durationInFrames: Math.max(1, Math.round(__cfg.durationInFrames || 150)),
  fps: __cfg.fps || 30,
  width: __cfg.width || 1280,
  height: __cfg.height || 720,
});
registerRoot(RemotionRoot);
`
}
