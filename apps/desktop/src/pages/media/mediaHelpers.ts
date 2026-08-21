// apps/desktop/src/pages/media/mediaHelpers.ts
//
// Shared renderer-side helpers for the Surplus media surfaces (Chat inline +
// the dedicated Media studio tab). Everything here is pure renderer code that
// talks to Layer A via window.tachi.surplusMedia.* — no main-process imports.
import type { Artifact, SurplusMediaModality, ParamSpec } from '../../types/electron'
import type { ContentPart as ChatContentPart } from '../../store/chat.store'
// TYPE-ONLY, deliberately: media.store imports MediaProvider back out of this
// file, so a value import either way would be a runtime cycle. Both directions
// are erased at compile time.
import type { MediaGalleryEntry } from '../../store/media.store'
import { showToast } from '../../components/Toaster'

export type MediaContentPart = Extract<ChatContentPart, { type: 'image' | 'audio' | 'video' }>

/**
 * Build a renderer-loadable URL for an on-disk artifact via the tachi-media://
 * protocol (registered in main). A renderer served over http://localhost CANNOT
 * load file:// URLs, so file:// produced a broken image — this scheme streams
 * the file from main with the right Content-Type. Works for image/audio/video.
 */
export function mediaArtifactUrl(path: string): string {
  return `tachi-media://artifact/${encodeURIComponent(path)}`
}

/**
 * Build a renderable source for an artifact. Small images may carry inline base64
 * (instant, no round-trip); everything else (large images, audio, video) loads
 * from disk via the tachi-media:// protocol.
 */
export function artifactSrc(a: Artifact): string {
  if (a.kind === 'image' && a.b64) return `data:${a.mimeType};base64,${a.b64}`
  return a.path ? mediaArtifactUrl(a.path) : ''
}

/** Convert a media engine Artifact into a chat ContentPart (image/audio/video). */
export function artifactToContentPart(a: Artifact): ChatContentPart | null {
  const src = artifactSrc(a)
  if (a.kind === 'image') return { type: 'image', data: src, mimeType: a.mimeType }
  if (a.kind === 'audio') return { type: 'audio', src, mimeType: a.mimeType, path: a.path }
  if (a.kind === 'video') return { type: 'video', src, mimeType: a.mimeType, path: a.path }
  return null
}

/**
 * Save an artifact to a user-picked folder. For sync results we pass srcPath
 * explicitly (the jobId embedded in the engine path isn't returned to the
 * renderer). Returns the destination path, or null if the user cancelled.
 */
export async function saveArtifactToFolder(a: Artifact): Promise<string | null> {
  if (!a.path) {
    showToast({ kind: 'error', text: 'Nothing to save — artifact has no file on disk.' })
    return null
  }
  const destDir = await window.tachi.agent.pickFolder()
  if (!destDir) return null
  try {
    // jobId/index are unused for sync results when srcPath is provided; the
    // engine copies srcPath into destDir. Pass safe placeholders.
    const { path } = await window.tachi.surplusMedia.saveArtifact({
      jobId:   '',
      index:   0,
      destDir,
      srcPath: a.path,
    })
    showToast({ kind: 'info', text: `Saved to ${path}` })
    return path
  } catch (err) {
    showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Reveal an on-disk artifact in the OS file manager. */
export function revealArtifact(a: Artifact): void {
  if (!a.path) return
  window.tachi.shell.revealInFolder(a.path).catch(() => {/* swallow */})
}

/** File extensions accepted by the STT (transcription) file pickers. */
export const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm'

/** Read a File into a Uint8Array for the multipart transcribe call. */
export async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer()
  return new Uint8Array(buf)
}

// ── Which provider may serve which modality ──────────────────────────────────
//
// Driver finding (owner, live): provider = LOCAL with a checkpoint selected,
// navigate media → chat → media, and the chip came back SURPLUS with a cloud
// model list under it — prompt, size and modality all intact. The provider was
// MediaPage's own `useState('surplus')`, so a remount re-ran the initializer;
// it now lives in media.store next to the params that already survived.
//
// That leaves ONE reset that is legitimate: a provider that cannot serve the
// modality the user just switched to. MediaPage did that silently too. The rule
// is spelled out here so the fallback can be announced instead of guessed at —
// an unannounced flip to a cloud provider is a real unintended request.

export type MediaProvider = 'surplus' | 'venice' | 'local' | 'imgnai' | 'pollinations'

/** Modalities a provider can actually serve; absent = all of them. */
const PROVIDER_MODALITIES: Partial<Record<MediaProvider, readonly SurplusMediaModality[]>> = {
  // sd.cpp (image/video) + piper/kokoro (tts). No music, no transcription.
  local:  ['image', 'video', 'tts'],
  // imgnAI Katana covers image + video only.
  imgnai: ['image', 'video'],
  // Pollinations is image only — and KEYLESS, which is its whole point. Still
  // a CLOUD route (the prompt leaves the machine): egress-policy classifies
  // 'pollinations' as cloud and PRIVATE MODE blocks it like the others.
  pollinations: ['image'],
}

/** Brand spellings for toasts and chips ('imgnAI' is the one that cannot be
 *  produced by CSS text-transform, which is why the chip special-cases it). */
export function mediaProviderLabel(p: MediaProvider): string {
  switch (p) {
    case 'imgnai':       return 'imgnAI'
    case 'pollinations': return 'Pollinations'
    case 'surplus':      return 'Surplus'
    case 'venice':       return 'Venice'
    case 'local':        return 'Local'
  }
}

/** Can this provider serve this modality at all? */
export function providerServesModality(provider: MediaProvider, modality: SurplusMediaModality): boolean {
  const served = PROVIDER_MODALITIES[provider]
  return !served || served.includes(modality)
}

// ── The controls Pollinations can honestly render ────────────────────────────
//
// The param schema arrives from surplusMedia.modelParams, whose curated image
// fallback carries steps / cfg / sampler / negative_prompt / n / strength /
// image_url — none of which Pollinations' GET takes. imgnAI set the precedent
// of ignoring what it does not send, but a control that appears and does
// nothing is the audit-D1 class, so the pollinations route filters the schema
// to the three facts its URL actually carries: the prompt, the size (→ the
// width/height query params) and the seed (their cache replays prompt+seed —
// the same knob that makes Remix exact makes -1 a real re-roll, see main).

/** The schema params the Pollinations URL actually carries. */
export const POLLINATIONS_PARAM_NAMES: readonly string[] = ['prompt', 'size', 'seed']

/** Filter a curated schema down to what Pollinations honestly renders. */
export function pollinationsVisibleSchema(schema: ParamSpec[]): ParamSpec[] {
  return schema.filter(s => POLLINATIONS_PARAM_NAMES.includes(s.name))
}

/**
 * The provider to use for a modality, and whether that meant abandoning the
 * user's choice. `fellBack: true` is the caller's cue to SAY SO — never a
 * silent hop onto a billed route.
 */
export function resolveProviderForModality(
  provider: MediaProvider,
  modality: SurplusMediaModality,
): { provider: MediaProvider; fellBack: boolean } {
  if (providerServesModality(provider, modality)) return { provider, fellBack: false }
  return { provider: 'surplus', fellBack: true }
}

// ── ONE ROUTE, ONE MODEL LIST (the 1-second race) ────────────────────────────
//
// Driver finding (owner, live): click a MODALITY, then the LOCAL chip within
// ~1 s, and the MODEL dropdown still shows the CLOUD list while the Local chip
// is highlighted. It self-heals only on a provider toggle.
//
// Two model-list loads are in flight and nothing orders them. The modality
// click issues load A against the old provider (a gateway request over the
// network); the chip click issues load B against LOCAL (an sd-cpp status IPC,
// an order of magnitude faster). B lands first and paints the local list, A
// lands second and overwrites it — the LOSER of the race wins the screen, and
// it also gets to run `setModel(first-of-its-list)`, so the composer ends up
// pointing at a cloud model under a Local chip.
//
// The missing fact is the same in both halves of this file's fix: a response
// carried no record of WHICH ROUTE it was fetched for. With that recorded, the
// applier can drop a superseded one, and the footer can refuse to pair a
// provider with a list that belongs to a different one.

/** provider + modality — the pair that decides which catalog is correct. */
export interface MediaRoute {
  provider: MediaProvider
  modality: SurplusMediaModality
}

/** Same catalog? Null on either side is "unknown", which is never a match. */
export function sameMediaRoute(a: MediaRoute | null | undefined, b: MediaRoute | null | undefined): boolean {
  if (!a || !b) return false
  return a.provider === b.provider && a.modality === b.modality
}

/** A loaded model list, tagged with the route it was loaded FOR. */
export interface ModelListSnapshot {
  route:  MediaRoute
  models: ReadonlyArray<{ id: string; label: string }>
}

/**
 * The composer's "resolved route" line — the one place that says what GENERATE
 * will actually run (and bill).
 *
 * It used to read `{provider} · {models.find(...)}`: the provider from live
 * state, the label from whatever list happened to be loaded. During a modality
 * fallback those two disagree for ~250 ms and the line read "SURPLUS ·
 * SD-TURBO" — a cloud provider next to a local checkpoint, a route that cannot
 * exist. Both halves now come from ONE snapshot, and when the snapshot does not
 * belong to the active route there is no line at all: a blank beat is honest, a
 * fabricated pairing is not.
 *
 * `label: null` means the route agrees but this id is not in the list yet (a
 * Remix landing a moment early) — the caller supplies its own display name; the
 * PROVIDER half is still the one the list was loaded for, so nothing is a lie.
 */
export function resolveRouteEcho(
  active: MediaRoute,
  model: string,
  snapshot: ModelListSnapshot | null | undefined,
): { provider: MediaProvider; label: string | null } | null {
  if (!model) return null
  if (!snapshot || !sameMediaRoute(snapshot.route, active)) return null
  const found = snapshot.models.find(m => m.id === model)
  return { provider: snapshot.route.provider, label: found?.label ?? null }
}

// ── A stop the USER asked for is not an error ────────────────────────────────
//
// Driver finding (owner, live): pressed STOP on a local render, and the app
// answered with a red ERR toast — "sd-cli was stopped before it finished." The
// kill landed exactly as asked, and the app reported the outcome the user
// requested as a fault.
//
// The truth was already on the wire: describeSdExit takes a `cancelled` flag
// (a403875) and writes a different sentence for it, dropping the stderr tail
// because pasting "step 7/20" under a red heading reads like a diagnosis. Only
// the renderer's severity was blind to it — every failure went out as 'error'.
//
// TWO INDEPENDENT SIGNALS, either one sufficient:
//   • `stopping` — the renderer's OWN evidence, latched the instant Stop was
//     clicked (markRunStopping). Independent of how main words anything.
//   • the message — for a cancel that did not come from this component's
//     button (the canvas surface has no Stop of its own).
//
// The regex is deliberately narrow. describeSdExit has a SECOND sentence ending
// "before it finished." — `was killed (SIGKILL) before it finished.` — and that
// one IS a fault: an OOM reaper or Task Manager took the child down, which the
// user did not ask for and does need to see in red.
const SD_STOPPED_BY_USER = /\bwas stopped before it finished\.\s*$/

/**
 * The toast severity for a settled-with-a-message run. 'info' when the user
 * asked for this outcome; 'error' for everything else — the default stays the
 * loud one, so a new failure mode is never quietly downgraded.
 */
export function runFailureToastKind(input: { message: string; stopping: boolean }): 'info' | 'error' {
  if (input.stopping) return 'info'
  return SD_STOPPED_BY_USER.test(input.message.trim()) ? 'info' : 'error'
}

// ── The hint that went stale the day the row shipped ─────────────────────────
//
// Driver finding (owner, live): with Wan T2V selected, the RESOLUTION hint read
// "…starting from an image needs a Wan i2v checkpoint, which is not shipped
// either" — while the DOWNLOAD MODEL panel two inches below offered Wan 2.1 I2V
// 14B 480P. 0fab056 added the row; this sentence predates it.
//
// The sentence is built in MAIN (surplus-media-service's localVideoOptionsFor
// branch appends it whenever `!localVid.i2v`) and, like every schema
// description, ships in English only. The composer is the surface that can do
// both things the fix needs: translate it, and point it at the row that now
// exists. So main keeps writing the fact (this checkpoint is text→video only)
// and the renderer supplies the sentence that says what to do about it.
//
// Matched as a whole sentence, and pinned against the main-process source by
// test/unit/mediaLocalPanelCopy.test.ts: if main rewords it, the test fails
// rather than the screen quietly going back to the stale claim.

/** The exact sentence main appends for a non-i2v LOCAL video row. */
export const T2V_ONLY_SENTENCE =
  'It is text→video only: starting from an image needs a Wan i2v checkpoint, which is not shipped either.'

/** The shipped i2v row's name, as the download panel spells it (sd-cpp-models). */
export const WAN_I2V_ROW_NAME = 'Wan 2.1 I2V 14B 480P'

/**
 * Swap main's stale "not shipped either" sentence for one that names the row.
 * Every other description — and every description that does not contain it —
 * comes back byte-identical.
 */
export function retargetT2vOnlyHint(
  description: string | undefined,
  replacement: string,
): string | undefined {
  if (!description || !description.includes(T2V_ONLY_SENTENCE)) return description
  return description.replace(T2V_ONLY_SENTENCE, replacement)
}

// ── The prompt field's canvas-only jargon (W4-C i18n sweep) ──────────────────
//
// Same shape of problem as the T2V hint above, one field over: the image
// prompt's schema description is built in MAIN (surplus-media-service's
// CURATED_SCHEMA) as "What to generate. Wire a text agent into the prompt plug
// to author this." — "wire ... into the prompt plug" is CANVAS wiring
// language. It reads fine on the node graph (the field really is a plug
// there), but ParamFields also renders this exact schema on the plain Media
// composer, which has no plugs at all — so half of this sentence describes a
// UI that surface doesn't have. Retargeted the same way: main keeps stating
// the fact (an upstream text step can fill this in), the renderer supplies a
// surface-neutral sentence that reads correctly on BOTH.
export const PROMPT_PLUG_JARGON_SENTENCE =
  'Wire a text agent into the prompt plug to author this.'

/**
 * Swap main's canvas-jargon prompt hint for a surface-neutral sentence. Every
 * other description — and every description that does not contain it — comes
 * back byte-identical.
 */
export function retargetPromptPlugHint(
  description: string | undefined,
  replacement: string,
): string | undefined {
  if (!description || !description.includes(PROMPT_PLUG_JARGON_SENTENCE)) return description
  return description.replace(PROMPT_PLUG_JARGON_SENTENCE, replacement)
}

// ── Schema label/description i18n (W4-C sweep) ───────────────────────────────
//
// Every ParamFields control is rendered from a ParamSpec authored in MAIN
// (CURATED_SCHEMA + modelParamSchema's per-row rewrites), which ships English
// only — main-process files are out of scope for a renderer-side fix, so the
// translation happens here instead, the same split the two hooks above use.
//
// LABELS are safe to translate by param `name` alone: main never re-templates
// a label with row-specific facts (numbers, checkpoint names, …), so the same
// English label always means the same translated one. The lone exception is
// `image_url`, whose label main sets to one of two literal strings depending
// on modality (img2img vs image→video) — matched by content instead of name.
//
// DESCRIPTIONS are NOT uniformly safe: several (`steps`, video's
// `resolution`/`duration`, image's `size`, the hires*/speed_mode controls) are
// re-templated per ROW with embedded facts a static translation would silently
// discard for a local checkpoint (its own step recipe, its native resolution,
// its fps…). Those are deliberately left to fall through to `t()`'s
// defaultValue (the exact text main just built) in EVERY locale rather than
// ship a translation that reads fine but is factually wrong for that row.
// Only params whose description never varies by row get a resource entry.
//
// `negative_prompt` and `n` are BOTH/AND: each has exactly one row-INDEPENDENT
// variant (the curated fallback's plain "what to avoid" sentence; the local
// batch-count row's fixed cost note, identical on every local image row) and
// one-or-more ROW-DEPENDENT variants that splice in facts (Wan's own negative
// prompt text, whether Speed is on, the cfg-1 inertness note). Matched by exact
// CONTENT, the same precedent `image_url` sets below: the one generic string
// gets a resource entry, and anything that does not match it byte-for-byte
// (i.e. every row-dependent composition) falls through untouched, in every
// locale, forever — so a translation cannot silently eat a checkpoint's own
// facts the way a blind per-name lookup would.
const IMAGE_URL_LABEL_IMG2IMG = 'Reference image (img2img)'
const IMAGE_URL_LABEL_I2V = 'Init frame (image→video)'
const IMAGE_URL_DESC_IMG2IMG = 'Optional starting image for img2img.'
const IMAGE_URL_DESC_I2V = 'Optional first frame (image→video).'
/** The curated fallback's negative-prompt sentence — used verbatim only when no
 *  local row appended its own row-specific facts to it (see surplus-media-service's
 *  negative_prompt handling: a local row's composed description never equals this
 *  string alone, so it can never accidentally match here). */
const NEGATIVE_PROMPT_GENERIC_DESC = 'What to avoid (artifacts, watermarks, extra limbs, …).'
/** The local batch-count row's cost note (surplus-media-service, `n` on a local
 *  image row) — fixed across every local checkpoint, unlike the recipe params. */
const BATCH_N_GENERIC_DESC =
  'How many images to generate in one run. The checkpoint loads once, but each image is sampled in full — 4 images take about 4x as long as 1. Each gets its own seed, counting up from the first.'

/** `t`-shaped translate function — kept minimal so callers can hand in react-i18next's `t` directly. */
type Translate = (key: string, options: { defaultValue: string }) => string

export function resolveParamLabel(name: string, label: string, t: Translate): string {
  if (name === 'image_url') {
    if (label === IMAGE_URL_LABEL_IMG2IMG) return t('params.image_url.labelImg2img', { defaultValue: label })
    if (label === IMAGE_URL_LABEL_I2V) return t('params.image_url.labelI2v', { defaultValue: label })
    return t('params.image_url.label', { defaultValue: label })
  }
  return t(`params.${name}.label`, { defaultValue: label })
}

export function resolveParamDescription(
  name: string,
  description: string | undefined,
  t: Translate,
): string | undefined {
  if (!description) return description
  if (name === 'image_url') {
    if (description === IMAGE_URL_DESC_I2V) return t('params.image_url.descriptionI2v', { defaultValue: description })
    if (description === IMAGE_URL_DESC_IMG2IMG) return t('params.image_url.description', { defaultValue: description })
    return description
  }
  if (name === 'negative_prompt') {
    if (description === NEGATIVE_PROMPT_GENERIC_DESC) return t('params.negative_prompt.description', { defaultValue: description })
    return description // a local row's own composed sentence — stays English by design (see doc comment above)
  }
  if (name === 'n') {
    if (description === BATCH_N_GENERIC_DESC) return t('params.n.description', { defaultValue: description })
    return description // the cloud curated fallback's "variations" sentence — untouched, same as before
  }
  return t(`params.${name}.description`, { defaultValue: description })
}

// ── The download panel must know what is already on disk ─────────────────────
//
// Driver finding (owner, live): SD-Turbo, Wan and the user's own civitai-142421
// render as identical DOWNLOAD MODEL buttons whether or not the weights are
// already there. The page is not missing the information — it will not offer to
// generate with a checkpoint that is not installed — it simply never handed it
// to this panel. Clicking one of those buttons re-fetches several GB to end up
// exactly where it started.
//
// The source is `localRows`, the sd-cpp:status snapshot keyed by INSTALLED id
// (the same map that gates generation and feeds the preset/LoRA compat checks),
// so there is no second source of truth to drift.

/**
 * What the DOWNLOAD MODEL panel may honestly offer this row.
 *
 * The third state is the rows5 driver finding: a download that died mid-file
 * rendered the SAME button as one that was never started. `onDiskMb` — this
 * row's own completed components and `.part` bytes, straight from main — is the
 * durable evidence that it WAS started, and the only evidence that survives the
 * tab being closed while a multi-GB transfer runs.
 *
 * Order matters: installed outranks everything (a complete row has nothing to
 * resume), and a nonsense figure decays to a plain download rather than
 * inventing an interrupted install that never happened.
 */
export type SdDownloadRowState = 'installed' | 'resume' | 'download'

export function sdDownloadRowState(
  id: string,
  installedIds: Iterable<string>,
  onDiskMb = 0,
): SdDownloadRowState {
  for (const installed of installedIds) if (installed === id) return 'installed'
  return Number.isFinite(onDiskMb) && onDiskMb > 0 ? 'resume' : 'download'
}

// ── …and what that download will actually COST ───────────────────────────────
//
// Driver finding (owner, live): the Wan I2V row's button read "17.6 GB" while
// its own hover tooltip said ~11.7 GB, because two of its four components are
// the 2.1 vae + umt5 encoder a Wan owner already has — and the tooltip was
// right (the real transfer for the shared pair was ~1 MB). The number that
// decides whether someone starts the download was the pessimistic one; the
// honest one was behind a hover.
//
// The evidence is `sharedWith` from the catalog (main answers "which other rows
// declare these exact bytes", sha-identical — see SdCatalogFile) crossed with
// the installed set. It is sound in both directions: `isSdModelInstalled` is
// true only when EVERY component of a row is on disk, and a row that shares
// nothing keeps its full price.
//
// It is a PREDICTION, like the tooltip's — the installer re-hashes a twin
// before placing it and re-downloads if the bytes drifted. The copy therefore
// says "shares files with installed models", never "you will transfer exactly".

// …AND WHAT IS ALREADY HERE FROM THE LAST ATTEMPT ─────────────────────────────
//
// Driver finding (owner, live, rows5): the TI2V-5B row's button read "6.3 GB"
// with 5.1 GB of its own diffusion.gguf already completed on disk. The discount
// above was working — 6.3 GB is 12.0 GB minus the umt5 encoder a Wan owner
// already has — it simply had no idea about the row's OWN bytes. The installer
// skips a landed component and resumes a `.part`, so neither will travel; the
// label promised both anyway.
//
// They come back as their own field rather than folded into `savedMb`, because
// they are a different fact about the row: `savedMb` says "you own this file
// already", `onDiskMb` says "this download was started and stopped". Only the
// second one justifies the word RESUME, and only the panel can spend it.

export interface SdDownloadSizeInput {
  /** The row's component files, as `sd-cpp:catalog` sends them. */
  files: ReadonlyArray<{
    sizeMb: number
    sharedWith?: readonly string[]
    /** MiB of THIS component already on disk (landed file or `.part`). */
    onDiskMb?: number
  }>
  /** Every sd.cpp model id currently ON DISK (sd-cpp:status). */
  installedIds: Iterable<string>
}

export interface SdDownloadSize {
  /** Everything this row is made of. */
  totalMb:       number
  /** What will actually travel — the number the button should show. */
  incrementalMb: number
  /** What the dedup against OTHER installed rows saves. 0 = nothing is shared. */
  savedMb:       number
  /** This row's own bytes from an interrupted attempt. 0 = never started. */
  onDiskMb:      number
}

export function sdDownloadSize(input: SdDownloadSizeInput): SdDownloadSize {
  const installed = new Set(input.installedIds)
  let totalMb  = 0
  let savedMb  = 0
  let onDiskMb = 0
  for (const f of input.files) {
    const size = Number.isFinite(f.sizeMb) ? f.sizeMb : 0
    totalMb += size
    // No `sharedWith` at all = an older main build: no evidence, no discount.
    if ((f.sharedWith ?? []).some(id => installed.has(id))) {
      // A shared file the installer has ALREADY hard-linked into this row's
      // directory is both shared and on disk. It is one set of bytes and it is
      // subtracted once, or the label goes negative.
      savedMb += size
      continue
    }
    const here = Number.isFinite(f.onDiskMb) ? (f.onDiskMb as number) : 0
    // `sizeMb` is the registry's rounded estimate and the real file can exceed
    // it, so a fat component must not eat into its neighbours' cost.
    onDiskMb += Math.min(Math.max(here, 0), size)
  }
  return { totalMb, incrementalMb: totalMb - savedMb - onDiskMb, savedMb, onDiskMb }
}

// ── THE PACK DISCOUNT, ON THE ROW THAT HAS TO BE BOUGHT FIRST ────────────────
//
// Driver finding (speed A/B, 2026-07-31): the two curated speed packs share one
// byte-identical LoRA, so once either is installed the other costs ~0.6 GB
// instead of 1.3. `sdDownloadSize` already computes that and the pack button
// already shows it — but the pack block renders ONLY for the model that is
// SELECTED AND INSTALLED. A user reading the 12.1 GB Wan 2.2 A14B download row
// therefore could not learn that the thing which makes it usable is nearly free
// until after paying for the checkpoint.
//
// A NOTE ON THE ROW, not a restructured panel: the question ("is the fast path
// cheap for me?") is asked while looking at the price, and answering it costs
// one line. Returns null unless there is a real discount to quote — a row with
// no pack, an installed pack, or a pack that shares nothing says nothing, which
// is the same fail-quiet `sdRowLicense` and `sharedWith` already use.

/** One entry of the `sd-cpp:speed-adapters` snapshot, as this note needs it. */
export interface SpeedPackDiscountInput {
  /** The download row being labelled. */
  modelId: string
  packs: ReadonlyArray<{
    modelId:       string
    sizeMbTotal:   number
    installed:     boolean
    /** What this pack would ACTUALLY transfer — sdDownloadSize's incrementalMb. */
    incrementalMb: number
  }>
}

/** MiB the pack would cost this user, and MiB it costs from scratch. */
export interface SpeedPackDiscount {
  incrementalMb: number
  fullMb:        number
}

export function speedPackDiscountNote(input: SpeedPackDiscountInput): SpeedPackDiscount | null {
  const pack = input.packs.find(p => p.modelId === input.modelId)
  if (!pack) return null
  if (pack.installed) return null                         // nothing left to advertise
  if (!(pack.incrementalMb < pack.sizeMbTotal)) return null // no sharing, no news
  return { incrementalMb: pack.incrementalMb, fullMb: pack.sizeMbTotal }
}

// ── WHAT THE MACHINE NEEDS, ON THE ROW THAT SPENDS THE BYTES ─────────────────
//
// W4-A put `minVramGb` / `minRamGb` on the sd-cpp catalog payload, and W4-B
// renders them on the CATALOG card. The Media tab's own DOWNLOAD panel — which
// is where the multi-GB button actually is, and the only one a user who never
// opens the Catalog tab will ever see — dropped both fields in its mapping.
//
// THE VERDICT IS A COMPARISON, NOT A COMPUTATION, and that is the whole design:
// the row states what it needs (from its own notes, per W4-A's rule) and the
// probe states what the machine has. Green when it clears, amber when it does
// not. Nothing is estimated from file size — that is exactly the fabricated
// verdict W4-B removed from the card, which called Flux too big for the 12 GB
// card that runs it.
//
// THREE WAYS THIS RETURNS NULL, all of them honest:
//   • the row declares no figure (its notes state none) — the panel says nothing
//     rather than inventing a threshold;
//   • the probe could not read the hardware — an unknown machine cannot fail a
//     comparison, and "amber" would be a claim about a number we do not have;
//   • the numbers are not finite/positive.
//
// AMBER IS NOT "WILL NOT RUN". Peak memory on these pipelines moves with
// resolution, frame count and the offload flags, so a row above the line is a
// heads-up ("expect to use the low-VRAM flags"), never a refusal — and the copy
// this drives says so. That is why the shortfall is carried too: the caller can
// tell a 1 GB gap from a 20 GB one.

export interface MediaFitLineInput {
  /** The row, as the download panel holds it. Either field may be absent. */
  row: { minVramGb?: number; minRamGb?: number }
  /** Free VRAM in bytes, as the hardware probe reports it. Null ⇒ unknown. */
  vramFreeBytes?: number | null
  /** Total system RAM in bytes. Null ⇒ unknown. */
  ramTotalBytes?: number | null
}

export interface MediaFitLine {
  /** Which constraint this line is about — the row can only state one binding. */
  kind:  'vram' | 'ram'
  /** true ⇒ the machine clears the row's own stated figure. */
  fits:  boolean
  /** What the row asked for, in GiB (one decimal). */
  needGb: number
  /** What the machine has, in GiB (one decimal). */
  haveGb: number
}

const GIB = 1024 * 1024 * 1024

/**
 * The green/amber line under one download row, or null when there is nothing
 * honest to say. VRAM is checked first: it is the binding constraint on every
 * row that names one, and `minRamGb` exists for the rows where it is NOT (the
 * LTX-AV row holds its weights in system memory, so a 24 GB card does not help
 * it and 32 GB of RAM does).
 */
export function mediaFitLine(input: MediaFitLineInput): MediaFitLine | null {
  const round = (n: number): number => Math.round(n * 10) / 10
  const pos = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null

  const needVram = pos(input.row?.minVramGb)
  if (needVram !== null) {
    const haveBytes = pos(input.vramFreeBytes)
    if (haveBytes === null) return null   // unknown machine: no verdict at all
    const haveGb = haveBytes / GIB
    return { kind: 'vram', fits: haveGb >= needVram, needGb: round(needVram), haveGb: round(haveGb) }
  }

  const needRam = pos(input.row?.minRamGb)
  if (needRam !== null) {
    const haveBytes = pos(input.ramTotalBytes)
    if (haveBytes === null) return null
    const haveGb = haveBytes / GIB
    return { kind: 'ram', fits: haveGb >= needRam, needGb: round(needRam), haveGb: round(haveGb) }
  }

  return null
}

// ── THE LICENCE ON THE BUTTON (the LTX-2.3 unlock) ───────────────────────────
//
// Every local row until now was Apache-2.0 or OpenRAIL and the panel said
// nothing, which was survivable because nothing it could say would have changed
// a decision. LTX-2.3 breaks that: the weights are under the LTX-2 Community
// License, commercial use is granted only below $10M in annual revenue, and the
// text encoder carries Google's Gemma Terms. A 20.8 GB button that mentions
// none of it is not informed consent — and informed consent is precisely the
// part that IS ours, since the bytes come from Lightricks'/unsloth's own repos
// and this app distributes nothing.
//
// A pure resolver rather than JSX inline, for the reason every other rule in
// this file is one: the panel is not the only thing that will ever want to ask
// "what is this row's licence", and a `row.licenseName && row.licenseUrl &&`
// chain repeated at a second call site is a chain that will disagree.
//
// BOTH FIELDS OR NEITHER. A name with no link is a claim the user cannot check,
// and a link with no name is a bare URL under a download button. An older main
// build sends neither, and the panel simply renders nothing — the same
// fail-quiet the `sharedWith` / `onDiskMb` fields already use.

export interface SdRowLicense {
  name: string
  url:  string
}

/** The licence line for a catalog row, or null when it declares none. */
export function sdRowLicense(row: { licenseName?: string; licenseUrl?: string }): SdRowLicense | null {
  const name = typeof row.licenseName === 'string' ? row.licenseName.trim() : ''
  const url  = typeof row.licenseUrl  === 'string' ? row.licenseUrl.trim()  : ''
  if (!name || !url) return null
  // https only: this string is handed to shell.openExternal, which will happily
  // launch whatever protocol handler a `file:` or custom scheme names.
  if (!/^https:\/\//i.test(url)) return null
  return { name, url }
}

// ── A DERIVED FILE THAT IS NOT IN THE GALLERY DOES NOT EXIST ─────────────────
//
// Driver finding (owner, live): two RIFE runs finished — the rail showed real
// frame counts, the toast said "Saved …-rife2x.mp4" — and the gallery stayed at
// 22 entries. Once the toast was dismissed there was no route back to the file
// from inside the app at all.
//
// The wire existed and was never connected: RifeAction declares `onSaved` and
// fires it on success; MediaPage rendered `<RifeAction path style />` and
// nothing listened. So the interpolated clip lands in the gallery the same way
// a finished generation does — through media.store's `addEntry` — and this is
// the pure builder for the entry it lands as.
//
// WHAT IT IS NOT: it is not an extra artifact hung under the source card. The
// source entry's `model` and `params` describe the run that made the SOURCE
// frames; these frames were interpolated from them by rife-ncnn-vulkan, and
// filing them under Wan's params would attribute pixels no generator produced.
// It carries neither `params` (⇒ no Remix button, which would offer to re-run
// the source recipe) nor `provider` (nothing was billed, nothing to restore).

/** The engine that produced these frames — rife-plan's RIFE_MODEL_DIR. */
export const RIFE_DERIVED_MODEL_ID = 'rife-v4.6'

/** How much of the source's name the provenance line may carry. */
export const DERIVED_SOURCE_NAME_MAX = 80

/** The last path segment, for a POSIX or a Windows path. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(cut + 1)
}

/**
 * What to CALL the clip this was derived from: its prompt, else the file name
 * (an imported video has no prompt), else the model that made it. Capped —
 * a 400-character prompt would otherwise be persisted a second time in full.
 */
export function derivedSourceName(
  source: Pick<MediaGalleryEntry, 'prompt' | 'model'>,
  sourcePath?: string,
): string {
  const candidates = [source.prompt, sourcePath ? baseName(sourcePath) : '', source.model]
  const name = candidates.map(c => (c ?? '').trim()).find(c => c !== '') ?? ''
  return name.length > DERIVED_SOURCE_NAME_MAX
    ? `${name.slice(0, DERIVED_SOURCE_NAME_MAX)}…`
    : name
}

export interface InterpolatedEntryInput {
  /** What the clip was derived from. Only the two fields the provenance line
   *  reads are required, so the canvas can pass a stand-in for an imported clip
   *  that has no gallery entry at all. */
  source:      Pick<MediaGalleryEntry, 'prompt' | 'model'>
  /** The artifact path the run was started FROM (for the fallback name). */
  sourcePath?: string
  /** Absolute path of the file the run wrote. */
  outputPath:  string
  /** Epoch ms. */
  now:         number
  /** The translated provenance line, given the source's display name. */
  label:       (sourceName: string) => string
  /** The gallery as it stands — the same on-disk-path dedup addNodeRunArtifacts uses. */
  existing?:   readonly MediaGalleryEntry[]
}

/**
 * The gallery entry a finished interpolation becomes — or null when there is
 * nothing honest to add (no output path, or this exact file is already in the
 * gallery: one file on disk is one row, however many times a run reports it).
 */
export function interpolatedGalleryEntry(input: InterpolatedEntryInput): MediaGalleryEntry | null {
  const outputPath = (input.outputPath ?? '').trim()
  if (!outputPath) return null
  const already = (input.existing ?? []).some(e => e.artifacts.some(a => a.path === outputPath))
  if (already) return null
  return {
    id:        `rife-${input.now}-${baseName(outputPath)}`,
    // The engine that made these frames — NOT the source checkpoint.
    model:     RIFE_DERIVED_MODEL_ID,
    modality:  'video',
    prompt:    input.label(derivedSourceName(input.source, input.sourcePath)),
    // rife-plan's rifeOutputPath forces `.mp4` (H.264 in mp4) whatever the
    // source container was, so the type is a fact rather than a guess.
    artifacts: [{ kind: 'video', mimeType: 'video/mp4', path: outputPath } as Artifact],
    createdAt: input.now,
    source:    'derived',
  }
}

// ── THE SAME LAW, FOR AN UPSCALE ─────────────────────────────────────────────
//
// `-M upscale` produces a new file from an existing one, so it files exactly the
// way an interpolation does: its own entry, attributed to the engine that made
// it, with NO `params` (⇒ no Remix, which would offer to re-run the source's
// recipe under pixels no sampler produced) and NO `provider` (nothing billed).
//
// HERE THE REFUSAL IS NOT MERELY PRINCIPLED — the engine actively invites the
// mistake. The upscaled PNG carries a `parameters` tEXt chunk that reads
// "Steps: 20, CFG scale: 7.000000, Seed: 42, Size: 1024x1024, Sampler: NONE,
// mode: img_gen" on a 4096x4096 file that ran no sampler at all: sd-cli stamps
// its own defaults. Anything that copied the source entry's params, or read that
// chunk back, would publish a confident recipe for an image nobody generated.
//
// The one thing this entry says beyond the file path is WHAT WAS DONE and TO
// WHAT — "ESRGAN x4 · from: <source>" — which is the provenance the derived file
// would otherwise have nowhere to carry.

/** The engine that produced these pixels. Not the source checkpoint. */
export const UPSCALE_DERIVED_MODEL_ID = 'realesrgan'

export interface UpscaledEntryInput {
  /** What the image was derived from — the two fields the provenance line reads. */
  source:      Pick<MediaGalleryEntry, 'prompt' | 'model'>
  /** The artifact path the run was started FROM (for the fallback name). */
  sourcePath?: string
  /** Absolute path of the file the run wrote. */
  outputPath:  string
  /** Epoch ms. */
  now:         number
  /** The factor that ran, from the upscaler ROW — never hardcoded here. */
  scale:       number
  /** The translated provenance line, given the source's display name. */
  label:       (sourceName: string) => string
  /** The gallery as it stands — the same on-disk-path dedup the others use. */
  existing?:   readonly MediaGalleryEntry[]
}

/**
 * The gallery entry a finished upscale becomes — or null when there is nothing
 * honest to add (no output path, or this exact file is already listed).
 */
export function upscaledGalleryEntry(input: UpscaledEntryInput): MediaGalleryEntry | null {
  const outputPath = (input.outputPath ?? '').trim()
  if (!outputPath) return null
  const already = (input.existing ?? []).some(e => e.artifacts.some(a => a.path === outputPath))
  if (already) return null
  return {
    id:        `upscale-${input.now}-${baseName(outputPath)}`,
    model:     UPSCALE_DERIVED_MODEL_ID,
    modality:  'image',
    prompt:    input.label(derivedSourceName(input.source, input.sourcePath)),
    // upscaleOutputPath forces `.png` because the engine writes PNG whatever the
    // input container was — a fact rather than a guess.
    artifacts: [{ kind: 'image', mimeType: 'image/png', path: outputPath } as Artifact],
    createdAt: input.now,
    source:    'derived',
  }
}

// ── …AND THE CANVAS HAD THE SAME HOLE ────────────────────────────────────────
//
// Driver finding (owner, live, rows5): the fix above closed the MEDIA-TAB card
// only. Run the same interpolation from a rife NODE and `-rife2x.mp4` reached
// the canvas Output card and the disk — and the gallery still held no rife
// entry.
//
// Canvas artifacts DO have a door to the gallery (useNodeRun →
// media.store.addNodeRunArtifacts, which the FLF driver proved dedup-aware),
// but that call sits behind `node.type === 'media'` and a rife node's type is
// 'rife'. It also cannot simply be let through: addNodeRunArtifacts files an
// entry under the NODE's model / prompt / params, and a rife node has none of
// the three — the row would claim a checkpoint generated frames it interpolated.
//
// So the canvas takes the SAME builder the gallery card takes. The only thing it
// has to work out for itself is what the clip was derived FROM, and there are
// exactly two honest answers: the gallery entry that owns the source path when
// the clip was generated here, and the file name when it was not (an imported
// video, or one whose entry has aged out of the gallery cap) — which is the
// fallback derivedSourceName already supports.

/** The two fields the provenance line reads, for a clip with no gallery entry. */
const UNKNOWN_SOURCE: Pick<MediaGalleryEntry, 'prompt' | 'model'> = { prompt: '', model: '' }

export interface CanvasInterpolatedInput {
  /** The clip the rife node opened — rifeSourcePath's answer. */
  sourcePath?: string
  /** What the run produced, as the node run reports them. */
  artifacts:   ReadonlyArray<{ kind?: string; path?: string }>
  /** The LIVE gallery: both the provenance lookup and the dedup read it. */
  gallery:     readonly MediaGalleryEntry[]
  /** Epoch ms. */
  now:         number
  /** The translated provenance line, given the source's display name. */
  label:       (sourceName: string) => string
}

/**
 * The gallery entry a finished CANVAS interpolation becomes, or null when there
 * is nothing honest to add — no clip on disk in the run's artifacts, or a file
 * the gallery already holds.
 *
 * A b64-only artifact is skipped for the same reason wiredVideoPathsInto skips
 * one: the gallery row is a route back to a FILE, and there is no file.
 */
export function canvasInterpolatedGalleryEntry(input: CanvasInterpolatedInput): MediaGalleryEntry | null {
  const outputPath = (input.artifacts ?? [])
    .find(a => a?.kind === 'video' && typeof a.path === 'string' && a.path.trim() !== '')
    ?.path
  if (!outputPath) return null
  const sourcePath = (input.sourcePath ?? '').trim()
  const gallery = input.gallery ?? []
  const source = (sourcePath
    ? gallery.find(e => e.artifacts.some(a => a.path === sourcePath))
    : undefined) ?? UNKNOWN_SOURCE
  return interpolatedGalleryEntry({
    source,
    ...(sourcePath ? { sourcePath } : {}),
    outputPath,
    now:      input.now,
    label:    input.label,
    existing: gallery,
  })
}

// ── "PIN TO TOP" HAD TO ACTUALLY GO TO THE TOP ───────────────────────────────
//
// The gallery card's button says "Pin to top" and toggles `favorite`. The MEDIA
// tab then rendered `gallery.map(…)` in store order, so the pinned entry stayed
// exactly where it was — the label described an intention nothing carried out.
// The ARTIFACTS tab over the SAME store has always sorted (ArtifactsPage's
// comparator), so one store answered "where does a pin go" two different ways,
// and the tab holding the button was the one that was wrong.
//
// A shared comparator rather than a second inline `.sort()`: two copies of an
// ordering rule are two rules waiting to disagree, which is the defect itself.
// Non-mutating — the argument is the store's own array.

/** Favorites first, newest-first inside each group. Never mutates the input. */
export function sortGalleryForDisplay<T extends { favorite?: boolean; createdAt: number }>(
  entries: readonly T[],
): T[] {
  return entries.slice().sort((a, b) => {
    const fa = a.favorite ? 1 : 0
    const fb = b.favorite ? 1 : 0
    if (fa !== fb) return fb - fa            // pinned favorites surface first
    return b.createdAt - a.createdAt         // newest first within a group
  })
}

// ── REMIX COULD NOT RESTORE WHAT THE COMPOSER WAS SHOWING ────────────────────
//
// Style, LoRAs and the VAE swap were three `useState`s in MediaPage, which cost
// twice:
//   • a tab switch unmounted the page and reset all three, while the prompt,
//     the size, the model and the provider all came back (they live in the
//     store) — the same defect the provider had before f19ffdd;
//   • they were never recorded on the ENTRY, so Remix rebuilt the params bag
//     faithfully and then re-ran with whatever style happened to be selected
//     and no adapters at all. The button that exists to reproduce a result
//     could not reproduce it.
//
// They now live in media.store (persisted, like `provider`) and are SNAPSHOT
// into `entry.params` at generate time under ONE reserved key.
//
// WHY A RESERVED KEY AND NOT THREE TOP-LEVEL ONES: `entry.params` is the schema
// bag — it is fed to `setParams` on Remix, healed against the active schema, and
// forwarded verbatim as `params` to every CLOUD provider. Three bare names
// (`style`, `loras`, `vae`) could collide with a real ParamSpec and would be
// sent to a gateway that never asked for them. One nested key cannot collide and
// is lifted straight back out (withoutLocalSelections) before the bag is
// restored, so nothing local ever reaches a cloud request.

/** The one reserved key a local run's selections are recorded under. */
export const LOCAL_SELECTIONS_PARAM_KEY = 'localSelections'

/** The composer selections a LOCAL run was assembled with. */
export interface LocalSelections {
  /** SD_STYLES id ('none' = pass-through). */
  style: string
  /** adapter id → weight, for the LoRAs that were switched ON. */
  loras: Record<string, number>
  /** VAE adapter id to swap in, '' = the checkpoint's own. */
  vae:   string
}

/** What "nothing was selected" is — the composer's own defaults. */
export const NO_LOCAL_SELECTIONS: LocalSelections = { style: 'none', loras: {}, vae: '' }

/** True when these selections are the defaults, i.e. there is nothing to record. */
function isDefaultSelection(sel: LocalSelections): boolean {
  return (sel.style === '' || sel.style === 'none')
    && sel.vae === ''
    && Object.keys(sel.loras ?? {}).length === 0
}

/**
 * Record the selections on a run's params. Returns the bag UNCHANGED when there
 * was no real choice to record — an entry should carry evidence, not an empty
 * envelope, and a pre-change entry and a defaults-only one then read back the
 * same way (as null, i.e. "the composer defaults").
 */
export function stampLocalSelections(
  params: Record<string, unknown>,
  sel: LocalSelections,
): Record<string, unknown> {
  if (isDefaultSelection(sel)) return params
  const loras: Record<string, number> = {}
  for (const [id, w] of Object.entries(sel.loras ?? {})) {
    if (typeof w === 'number' && Number.isFinite(w)) loras[id] = w
  }
  return {
    ...params,
    [LOCAL_SELECTIONS_PARAM_KEY]: { style: sel.style, loras, vae: sel.vae },
  }
}

/**
 * The selections an entry recorded, or null when it recorded none (a cloud run,
 * a run from before this landed, or a run with nothing selected). Null is the
 * caller's cue to restore the DEFAULTS rather than leave whatever is on screen:
 * Remix must describe the run it is reproducing, not the last thing clicked.
 *
 * Validated field by field — this comes back out of localStorage, where a hand
 * edit or an older build can leave anything at all.
 */
export function readLocalSelections(
  params: Record<string, unknown> | null | undefined,
): LocalSelections | null {
  const raw = params?.[LOCAL_SELECTIONS_PARAM_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.style !== 'string') return null
  const loras: Record<string, number> = {}
  if (rec.loras && typeof rec.loras === 'object' && !Array.isArray(rec.loras)) {
    for (const [id, w] of Object.entries(rec.loras as Record<string, unknown>)) {
      if (typeof w === 'number' && Number.isFinite(w)) loras[id] = w
    }
  }
  return { style: rec.style, loras, vae: typeof rec.vae === 'string' ? rec.vae : '' }
}

/** The params bag WITHOUT the reserved key — what Remix hands back to the schema. */
export function withoutLocalSelections(params: Record<string, unknown>): Record<string, unknown> {
  if (!(LOCAL_SELECTIONS_PARAM_KEY in params)) return params
  const { [LOCAL_SELECTIONS_PARAM_KEY]: _drop, ...rest } = params
  return rest
}

/**
 * Drop the DEAD `aspect_ratio` field from a LOCAL IMAGE entry's params.
 *
 * `aspect_ratio` is a VIDEO-only control on the local route: modelParamSchema
 * drops it from every local IMAGE schema on purpose (orientation lives in
 * `size` itself now — see localGenParams' LOCAL_ROW_OWNED_PARAMS comment, "a
 * ratio control would be a second, approximate name for a choice already made
 * exactly"). But the params bag is persisted per MODALITY, not per schema, so
 * a value a CLOUD image run (which does offer the control) or an earlier
 * session left behind rides along unnoticed into a local entry.
 *
 * Checkpoint-B driver finding: a 512x768 local run recorded
 * `aspect_ratio: '1:1'` beside `size: '512x768'` — the dead field reading as a
 * lie next to the real one (512x768 is 2:3, not 1:1). Local VIDEO entries are
 * untouched: `aspect_ratio` is a live, rendered control there. So is every
 * CLOUD image entry — the control is real on that route and this must not
 * strip it.
 */
export function withoutLocalImageAspectRatio(params: Record<string, unknown>): Record<string, unknown> {
  if (!('aspect_ratio' in params)) return params
  const { aspect_ratio: _drop, ...rest } = params
  return rest
}

// ── ABSENCE IS NOT A VERDICT (the adapter-family axis) ───────────────────────
//
// An adapter runs on the checkpoint FAMILY it was trained against: an SD 1.5
// LoRA on an SDXL checkpoint is a tensor-shape mismatch the whole ecosystem
// silently no-ops with a console-only warning, so filtering the picker is right
// and stays.
//
// The gate was `a.family === activeLocalRow.family`, and that equality answered
// a question it was never asked: an adapter whose family is NOT RECORDED (an
// older registry row, a row installed before civitai-search learned to map its
// baseModel string) compared unequal to everything and DISAPPEARED from the
// picker — the app rendering "we do not know" as "it does not fit". A user
// hunting for their own LoRA has no way to tell that apart from a bug, and the
// count line ("N installed for a different base model") actively misinformed
// them, because that adapter is not known to be for a different base at all.
//
// The row's own family can be missing too (`x.family ?? ''` in the status
// mapper), and the same rule applies in that direction: a checkpoint that
// declares no family cannot rule anything out.
//
// So there are THREE answers, not two, and only the middle one hides anything.

export type AdapterFamilyVerdict = 'match' | 'unknown' | 'mismatch'

const normFamily = (f: string | null | undefined): string =>
  typeof f === 'string' ? f.trim().toLowerCase() : ''

/** Can this adapter run on a checkpoint of this family? Absence ⇒ 'unknown'. */
export function adapterFamilyVerdict(
  adapterFamily: string | null | undefined,
  rowFamily:     string | null | undefined,
): AdapterFamilyVerdict {
  const a = normFamily(adapterFamily)
  const r = normFamily(rowFamily)
  if (!a || !r) return 'unknown'
  return a === r ? 'match' : 'mismatch'
}

/**
 * Split the installed adapters against a checkpoint family.
 *
 * `offered` = everything that is not a KNOWN mismatch (match ∪ unknown), in the
 * original order. `mismatchCount` is what the "installed for a different base
 * model" line may honestly claim — an unknown-family adapter is not in it.
 */
export function partitionAdaptersByFamily<T extends { family?: string }>(
  adapters:  readonly T[],
  rowFamily: string | null | undefined,
): { offered: T[]; mismatchCount: number } {
  const offered: T[] = []
  let mismatchCount = 0
  for (const a of adapters) {
    if (adapterFamilyVerdict(a.family, rowFamily) === 'mismatch') mismatchCount++
    else offered.push(a)
  }
  return { offered, mismatchCount }
}

// ── Starter prompt presets ─────────────────────────────────────────────────────
//
// A small curated set of jump-start prompts per modality. The composer renders
// these as a dropdown that fills the prompt field; purely a convenience, never
// sent as anything other than the chosen prompt text.
//
// `id` is the STABLE identity: the dropdown's <option value> and the lookup key
// for the render-time i18n label (`presets.prompt.<modality>.<id>`, see
// promptPresetLabelKey below). `label` stays the English source text and the
// en-locale JSON value; `text` (the actual seeded prompt) is never translated —
// it is model input, not UI chrome, and this app renders that copy in English
// deliberately (see ADDING-A-PROVIDER conventions).
export interface PromptPreset { id: string; label: string; text: string }

export const PROMPT_PRESETS: Partial<Record<SurplusMediaModality, PromptPreset[]>> = {
  image: [
    { id: 'cinematicPortrait', label: 'Cinematic portrait', text: 'cinematic portrait, soft rim lighting, shallow depth of field, 85mm, photorealistic, high detail' },
    { id: 'isometricRoom',     label: 'Isometric room',     text: 'cozy isometric bedroom, warm lighting, soft pastel colors, clean vector style, high detail' },
    { id: 'logoMark',          label: 'Logo / mark',        text: 'minimal flat vector logo mark, bold geometric shape, single accent color on white, no text' },
    { id: 'conceptLandscape',  label: 'Concept landscape',  text: 'epic fantasy landscape at golden hour, dramatic clouds, distant mountains, painterly concept art' },
  ],
  video: [
    { id: 'slowDollyPush',     label: 'Slow dolly push',    text: 'slow cinematic dolly push toward subject, shallow depth of field, soft natural light' },
    { id: 'droneReveal',       label: 'Drone reveal',       text: 'aerial drone shot rising to reveal a sweeping coastal landscape at sunrise' },
    { id: 'productTurntable',  label: 'Product turntable',  text: 'product turntable on seamless white studio backdrop, smooth 360 rotation, soft shadows' },
  ],
  music: [
    { id: 'lofiBeat',          label: 'Lo-fi beat',         text: 'mellow lo-fi hip hop beat, warm vinyl crackle, jazzy keys, relaxed tempo' },
    { id: 'cinematicBuild',    label: 'Cinematic build',    text: 'cinematic orchestral build, swelling strings, deep percussion, hopeful resolution' },
    { id: 'synthwave',         label: 'Synthwave',          text: 'retro synthwave, pulsing analog bass, neon arpeggios, steady 110 bpm' },
  ],
  tts: [
    { id: 'friendlyIntro',     label: 'Friendly intro',     text: 'Hey there, and welcome. Let me walk you through what we built today.' },
    { id: 'announcement',      label: 'Announcement',       text: 'Attention please: the next session is about to begin in the main hall.' },
  ],
}

/** Render-time label for a prompt preset — English `label` is the fallback the
 *  caller passes in as `defaultValue`; the translated dropdown text (if any)
 *  lives at `presets.prompt.<modality>.<id>` in the media namespace. */
export function promptPresetLabelKey(modality: SurplusMediaModality, id: string): string {
  return `presets.prompt.${modality}.${id}`
}

// ── Performance-tier presets (Fooocus-style) ──────────────────────────────────
//
// Mirrors the SD_PRESETS shape in electron/services/sd-cpp-models.ts (which is
// the authoritative main-process copy). Renderer-only: fills existing
// steps / samplingMethod / cfgScale controls without touching IPC.
//
// Reference: Fooocus modules/flags.py Performance enum.

export type SdModelFamily = 'sd15' | 'sdxl' | 'flux'

export interface SdPresetParams {
  steps:          number
  samplingMethod: string
  cfgScale:       number
}

export interface SdPreset {
  id:     string
  params: Record<SdModelFamily, SdPresetParams>
}

export const SD_PRESETS: SdPreset[] = [
  {
    id: 'lightning',
    params: {
      sd15: { steps: 1,  samplingMethod: 'euler',   cfgScale: 1.0 },
      sdxl: { steps: 1,  samplingMethod: 'euler',   cfgScale: 1.0 },
      flux: { steps: 1,  samplingMethod: 'euler',   cfgScale: 1.0 },
    },
  },
  {
    id: 'speed',
    params: {
      sd15: { steps: 10, samplingMethod: 'euler_a', cfgScale: 5.0 },
      sdxl: { steps: 10, samplingMethod: 'euler_a', cfgScale: 5.0 },
      flux: { steps: 4,  samplingMethod: 'euler',   cfgScale: 1.0 },
    },
  },
  {
    id: 'quality',
    params: {
      sd15: { steps: 28, samplingMethod: 'dpm++2m', cfgScale: 7.0 },
      sdxl: { steps: 28, samplingMethod: 'dpm++2m', cfgScale: 5.0 },
      flux: { steps: 20, samplingMethod: 'euler',   cfgScale: 1.0 },
    },
  },
]

// ── Which tiers a ROW may honestly offer (audit D5) ──────────────────────────
//
// MIRROR of presetsForRow / isDistilledRow in electron/services/sd-cpp-models.ts
// — test/unit/mediaLocalGenParams.test.ts pins the two copies against each other
// so a change to one that skips the other fails there rather than in the UI.
//
// The picker used to hand every row the column its FAMILY matched, falling
// through to sd15 for anything without one. That gave Wan (a 20-step / cfg-6
// video model) a 28-step "Quality" and a 1-step "Lightning" that is pure noise,
// and it gave SD-Turbo — one step, by construction — the full sd15 ladder up to
// 28 steps: 28x the time for a worse image.

export interface SdPresetOffer {
  id:     string
  params: SdPresetParams
}

/** A row whose own recipe is a few steps at guidance ~1 is step-distilled. */
export function isDistilledRow(row: { steps: number; cfgScale: number }): boolean {
  return row.steps <= 4 && row.cfgScale <= 1.5
}

/**
 * The tiers this row can honestly offer: none for a distilled row (its own
 * setting is the only one that works), the family column for sd15/sdxl/flux,
 * and two tiers DERIVED FROM THE ROW for anything else (wan) — never an
 * invented 1-step tier.
 */
export function presetsForRow(row: {
  family:         string
  steps:          number
  cfgScale:       number
  samplingMethod: string
}): SdPresetOffer[] {
  if (isDistilledRow(row)) return []
  if (row.family === 'sd15' || row.family === 'sdxl' || row.family === 'flux') {
    const fam = row.family
    return SD_PRESETS.map(p => ({ id: p.id, params: { ...p.params[fam] } }))
  }
  return [
    { id: 'speed',   params: { steps: Math.max(1, Math.round(row.steps / 2)), samplingMethod: row.samplingMethod, cfgScale: row.cfgScale } },
    { id: 'quality', params: { steps: row.steps,                              samplingMethod: row.samplingMethod, cfgScale: row.cfgScale } },
  ]
}

// ── Style presets (Fooocus-style) ─────────────────────────────────────────────
//
// Mirrors SD_STYLES in electron/services/sd-cpp-models.ts.
// Reference: Fooocus modules/sdxl_styles.py (apply_style replaces {prompt}).

export interface SdStyle {
  id:       string
  positive: string
  negative: string
}

/**
 * Apply a style to a user prompt.  Returns { positive, negative } to pass
 * straight into the generate call — renderer-side only, no IPC change.
 */
export function applyStyle(
  style: SdStyle,
  userPrompt: string,
  existingNegative = '',
): { positive: string; negative: string } {
  const positive = style.positive.includes('{prompt}')
    ? style.positive.replace('{prompt}', userPrompt)
    : userPrompt ? `${style.positive}, ${userPrompt}` : style.positive
  const negative = [style.negative, existingNegative].filter(Boolean).join(', ')
  return { positive, negative }
}

export const SD_STYLES: SdStyle[] = [
  { id: 'none',           positive: '{prompt}',                                                                                         negative: '' },
  { id: 'cinematic',      positive: '{prompt}, cinematic, dramatic lighting, anamorphic lens, film grain, color graded, 4k',            negative: 'flat, cartoon, illustration, low quality, blurry' },
  { id: 'photorealistic', positive: '{prompt}, photorealistic, DSLR, sharp focus, high detail, natural lighting, 8k',                  negative: 'painting, illustration, anime, cartoon, sketch, rendering, low quality' },
  { id: 'digital-art',    positive: '{prompt}, digital art, concept art, vibrant colors, detailed illustration, trending on artstation', negative: 'photo, photorealistic, low detail, blurry' },
  { id: 'anime',          positive: '{prompt}, anime style, cel shading, clean lines, vibrant, high quality anime key visual',          negative: 'photo, photorealistic, western art, 3d render, deformed' },
  { id: 'oil-painting',   positive: '{prompt}, oil painting, classical art, impasto texture, masterpiece, detailed brushwork',           negative: 'photo, digital art, flat, cartoon, 3d render' },
  { id: 'pixel-art',      positive: '{prompt}, pixel art, retro 8-bit style, limited palette, crisp pixels, isometric',                 negative: 'photo, smooth gradients, realistic, blurry, high resolution' },
  { id: 'watercolor',     positive: '{prompt}, watercolor painting, soft washes, delicate, paper texture, artistic',                    negative: 'photo, sharp edges, digital, 3d render, oil paint' },
  { id: 'neon-noir',      positive: '{prompt}, neon noir, cyberpunk, rain-slicked streets, neon reflections, dark dramatic, high contrast', negative: 'daytime, bright, pastel, wholesome, low detail' },
  { id: 'fantasy-epic',   positive: '{prompt}, epic fantasy illustration, detailed environment, volumetric light, mystical atmosphere',  negative: 'modern, urban, realistic photo, low detail' },
]

// ── THE GALLERY'S "NEWEST" TIMESTAMP — locale-formatted, not OS-formatted ────
//
// Checkpoint-B driver finding: switching the app to RU left the newest-entry
// pill (and its hover title) reading en-US 12-hour time. The call sites passed
// NO locale to `toLocaleTimeString` / `toLocaleString`, so Intl fell back to
// the RUNTIME's default — the OS locale — which can silently disagree with the
// UI language the user picked in Settings. Same precedent as
// civitaiAdultPolicy's `formatCivitaiAcceptedAt(value, i18n.language)`: an
// invalid/unsupported BCP-47 tag throws in some engines, so a bad `locale` (or
// none) falls back to the platform default rather than crashing the gallery.
export function galleryTimestamp(createdAt: number, locale?: string): { time: string; full: string } {
  if (!Number.isFinite(createdAt)) return { time: '', full: '' }
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return { time: '', full: '' }
  try {
    return { time: d.toLocaleTimeString(locale), full: d.toLocaleString(locale) }
  } catch {
    return { time: d.toLocaleTimeString(), full: d.toLocaleString() }
  }
}

export type { Artifact, SurplusMediaModality }
