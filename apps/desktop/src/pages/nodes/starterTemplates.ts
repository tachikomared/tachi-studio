// apps/desktop/src/pages/nodes/starterTemplates.ts
//
// Prebuilt starter workflows for the Nodes canvas. Each template is a complete,
// runnable graph (Provider -> Agent -> Agent) so a user can drop a working
// example onto the canvas and hit "Run flow" without wiring anything by hand.
//
// All templates use the free local router (freellmapi, providerId 'freellmapi')
// so they run with no API key — matching the "free first" ethos and the
// graph:run default-model path. Edges are routed with the same
// nearestHandlePair + APPROX_NODE_RECT logic the canvas uses, so the wires land
// on sensible handles immediately.
//
// Brutalist/plain: ids are stable, labels are human words.

import { nearestHandlePair, APPROX_NODE_RECT } from './canvas/EightHandles'
import type { TachiNode, TachiEdge } from './types'

const POS = {
  provider: { x: 60,  y: 160 },
  first:    { x: 360, y: 160 },
  second:   { x: 660, y: 160 },
} as const

function providerNode(id: string): TachiNode {
  return {
    id,
    type: 'provider',
    position: POS.provider,
    data: { label: 'Free models', providerId: 'freellmapi', model: 'auto' },
  }
}

function agentNode(id: string, position: { x: number; y: number }, label: string): TachiNode {
  return { id, type: 'agent', position, data: { label, harnessId: 'openclaude' } }
}

function edge(id: string, src: TachiNode, tgt: TachiNode, instruction?: string): TachiEdge {
  const sRect = { x: src.position.x, y: src.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const tRect = { x: tgt.position.x, y: tgt.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const { sourceHandle, targetHandle } = nearestHandlePair(sRect, tRect)
  return {
    id, source: src.id, target: tgt.id, sourceHandle, targetHandle,
    type: 'link', data: instruction ? { instruction } : {},
  }
}

export interface StarterTemplate {
  id:          string
  label:       string
  description: string
  /** Flow name applied when the template is loaded. */
  name:        string
  nodes:       TachiNode[]
  edges:       TachiEdge[]
}

/** Build a two-agent chain template: Provider -> agent A -> agent B. */
function chain(
  id: string,
  label: string,
  description: string,
  aLabel: string,
  bLabel: string,
  routeHint: string,
): StarterTemplate {
  const p = providerNode(`${id}-provider`)
  const a = agentNode(`${id}-a`, POS.first,  aLabel)
  const b = agentNode(`${id}-b`, POS.second, bLabel)
  return {
    id,
    label,
    description,
    name: label,
    nodes: [p, a, b],
    edges: [
      edge(`${id}-e1`, p, a),
      edge(`${id}-e2`, a, b, routeHint),
    ],
  }
}

// ── Agentic builders (tool-using templates) ──────────────────────────────────

function providerAt(id: string, position: { x: number; y: number }): TachiNode {
  return { id, type: 'provider', position, data: { label: 'Free models', providerId: 'freellmapi', model: 'auto' } }
}
// Tool-using templates need a model that can call functions. Free/OpenGateway
// models can't, so the agentic templates default to Bankr + Claude (reliable
// tool-calling). Swap to another tool-capable model if you prefer.
function bankrAt(id: string, position: { x: number; y: number }): TachiNode {
  return { id, type: 'provider', position, data: { label: 'Bankr', providerId: 'bankr', endpoint: 'llm.bankr.bot/v1', model: 'claude-sonnet-4.6' } }
}
function agentAt(id: string, position: { x: number; y: number }, label: string, system?: string, final?: boolean): TachiNode {
  return { id, type: 'agent', position, data: { label, harnessId: 'openclaude', ...(system ? { systemPrompt: system } : {}), ...(final ? { final: true } : {}) } }
}
function folderAt(id: string, position: { x: number; y: number }, label = 'Workspace'): TachiNode {
  return { id, type: 'folder', position, data: { label, path: '' } }
}
function roleAt(id: string, position: { x: number; y: number }, label: string, allowedTools: string[]): TachiNode {
  // 'skill' slot — carries the tool allowlist the compiler reads (data.allowedTools).
  return { id, type: 'skill', position, data: { label, skillId: id, description: '', allowedTools } }
}
// Extra provider helpers for the multi-provider showcase. Each maps to a real
// adapter in graph-to-agentkit (providerId + a sensible default model); the key
// is injected at runtime by graph.ipc, never stored in the flow.
function opengatewayAt(id: string, position: { x: number; y: number }): TachiNode {
  return { id, type: 'provider', position, data: { label: 'OpenGateway', providerId: 'opengateway', endpoint: 'opengateway.gitlawb.com/v1', model: 'mimo-v2.5-pro' } }
}
function surplusAt(id: string, position: { x: number; y: number }): TachiNode {
  return { id, type: 'provider', position, data: { label: 'Surplus', providerId: 'surplus', endpoint: 'www.surplusintelligence.ai/api/inference/v1', model: 'claude-sonnet-4.5' } }
}
// Tool nodes. A blank MCP url = the app's built-in (loopback) MCP server. Wire
// MCP/Internet to a TOOL-CAPABLE agent only (Bankr/Claude) — pure-LLM gateways
// (e.g. OpenGateway/mimo) terminate the run if handed a tool to call.
function mcpAt(id: string, position: { x: number; y: number }, label = 'MCP tools'): TachiNode {
  return { id, type: 'mcp', position, data: { label } } as TachiNode
}
function internetAt(id: string, position: { x: number; y: number }, label = 'Internet'): TachiNode {
  return { id, type: 'internet', position, data: { label } } as TachiNode
}

// ── Prompt + Media builders (text → media pipelines) ──────────────────────────
// A `prompt` node is a self-contained text step (provider+model+instruction) that
// AUTHORS a prompt; it plugs into a media node's `prompt` plug. Defaults to the
// free local router so these run with no key (the media GENERATION still needs a
// Surplus key, but the prompt-writing is free).
function promptAt(
  id: string, position: { x: number; y: number }, label: string, instruction: string, final = false,
): TachiNode {
  return {
    id, type: 'prompt', position,
    data: { label, providerId: 'freellmapi', endpoint: 'localhost:8080', model: 'auto', instruction, ...(final ? { final: true } : {}) },
  } as TachiNode
}

const MEDIA_LABEL: Record<string, string> = { image: 'Image', video: 'Video', music: 'Music', tts: 'TTS', stt: 'STT' }
/** `extra` overrides the node's data (label / provider / params) — a template
 *  that targets the LOCAL engine or pins a segment length says so here. */
function mediaAt(
  id: string, position: { x: number; y: number }, modality: 'image' | 'video' | 'music' | 'tts' | 'stt',
  extra?: Record<string, unknown>,
): TachiNode {
  return {
    id, type: 'media', position,
    data: { label: MEDIA_LABEL[modality], modality, prompt: '', params: {}, ...extra },
  } as TachiNode
}

/** A static Text node — its typed text IS its output, so it feeds the first
 *  prompt step without a model run. */
function textAt(id: string, position: { x: number; y: number }, label: string, text: string): TachiNode {
  return { id, type: 'text', position, data: { label, text, lastOutput: text } } as TachiNode
}

/**
 * Edge INTO a media node's named plug ('prompt', 'folder', or 'image' — the
 * init-frame / img2img handoff). Media nodes use
 * typed plugs (not the 8 spot handles), so the target handle MUST be the literal
 * plug id — nearestHandlePair (spot ids) would point at a handle the media node
 * doesn't render. Source side still auto-routes to the nearest spot.
 */
function mediaEdge(id: string, src: TachiNode, media: TachiNode, plug: 'prompt' | 'folder' | 'image' = 'prompt'): TachiEdge {
  const sRect = { x: src.position.x, y: src.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const tRect = { x: media.position.x, y: media.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
  const { sourceHandle } = nearestHandlePair(sRect, tRect)
  return { id, source: src.id, target: media.id, sourceHandle, targetHandle: plug, type: 'link', data: {} }
}

/** Single agent that can actually read/write files in a workspace. */
function codeHelperTemplate(): StarterTemplate {
  const p = bankrAt('ch-prov',   { x: 60, y: 60 })
  const f = folderAt('ch-folder',   { x: 60, y: 250 })
  const r = roleAt('ch-role',       { x: 60, y: 440 }, 'File editor', ['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  const a = agentAt('ch-agent',     { x: 440, y: 240 }, 'Coder',
    'You are a coding assistant. Read, create, and edit files in the workspace to complete the user\'s request. Keep changes minimal and correct.')
  return {
    id: 'code-helper', label: 'Code helper (files)', name: 'Code helper',
    description: 'One agent (Bankr/Claude) that reads & writes files in a folder you choose. Pick a folder, then run.',
    nodes: [p, f, r, a],
    edges: [edge('ch-e1', p, a), edge('ch-e2', f, a), edge('ch-e3', r, a)],
  }
}

/** Builder writes files, Reviewer (the MAIN output) reads + critiques them. */
function buildReviewTemplate(): StarterTemplate {
  const p  = bankrAt('br-prov',  { x: 40, y: 40 })
  const f  = folderAt('br-folder',  { x: 40, y: 230 })
  const re = roleAt('br-edit',      { x: 40, y: 420 }, 'File editor', ['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  const rr = roleAt('br-read',      { x: 430, y: 470 }, 'Read only', ['Read', 'Glob', 'Grep'])
  const builder  = agentAt('br-builder',  { x: 430, y: 150 }, 'Builder',
    'You build the requested feature by creating and editing files in the workspace.')
  const reviewer = agentAt('br-reviewer', { x: 800, y: 150 }, 'Reviewer',
    'You review the files the Builder produced. Read them, point out bugs and improvements, and fix small issues.', true)
  return {
    id: 'build-review', label: 'Build & Review (files, multi-agent)', name: 'Build and Review',
    description: 'Builder (Bankr/Claude) writes files in your folder, then Reviewer checks them. Pick a folder, then run.',
    nodes: [p, f, re, rr, builder, reviewer],
    edges: [
      edge('br-e1', p, builder), edge('br-e2', f, builder), edge('br-e3', re, builder),
      edge('br-e4', builder, reviewer, 'needs review'),
      edge('br-e5', p, reviewer), edge('br-e6', f, reviewer), edge('br-e7', rr, reviewer),
    ],
  }
}

/**
 * Expert roundtable — a multi-agent CHAT, not a tool flow. Several persona
 * agents deliberate in sequence (each SEES and builds on the previous expert's
 * take via the network's shared conversation state), then a CEO synthesizes the
 * final decision. Pure-LLM, so it runs on the free models with no key — switch
 * the provider node to Bankr for higher-quality discussion. Use the "Chat with
 * flow" panel to talk to the whole team; use "Add expert" to grow the panel.
 */
function expertRoundtableTemplate(): StarterTemplate {
  const p = providerAt('rt-prov', { x: 40, y: 220 })
  const frontend = agentAt('rt-frontend', { x: 380, y: 40 }, 'Frontend expert',
    'You are a senior Frontend engineer. Focus on UI/UX, component design, accessibility, and client-side performance. ' +
    'You speak first — give concrete, opinionated frontend recommendations for the request and set up the user-facing approach for the others to build on.')
  const backend = agentAt('rt-backend', { x: 380, y: 200 }, 'Backend expert',
    'You are a senior Backend engineer. Focus on APIs, data models, scalability, and security. ' +
    'Read the Frontend expert\'s take above and build on it: what must the backend provide to support their UI, and what concerns do you have? Be specific.')
  const seo = agentAt('rt-seo', { x: 380, y: 360 }, 'SEO & growth',
    'You are an SEO & growth expert. Focus on discoverability, page/content structure, metadata, Core Web Vitals, and acquisition. ' +
    'Read the engineers\' plan above and add concrete SEO/growth actions and any changes they should make to rank and convert.')
  const ceo = agentAt('rt-ceo', { x: 760, y: 200 }, 'CEO',
    'You are the CEO and final decision-maker. Read every expert\'s contribution above (Frontend, Backend, SEO). ' +
    'Resolve disagreements and synthesize ONE clear, prioritized plan: what we build, in what order, and why. End with the top 3 next actions.',
    true)
  return {
    id: 'expert-roundtable', label: 'Expert roundtable (multi-agent chat)', name: 'Expert roundtable',
    description: 'Frontend, Backend & SEO experts brainstorm in turn — each builds on the last — then the CEO synthesizes the plan. Edit each agent\'s Instructions to customize the persona, or click "Add expert". Open "Chat with flow" to talk to the team.',
    nodes: [p, frontend, backend, seo, ceo],
    edges: [
      edge('rt-pf', p, frontend), edge('rt-pb', p, backend), edge('rt-ps', p, seo), edge('rt-pc', p, ceo),
      edge('rt-fb', frontend, backend, 'build on the frontend plan'),
      edge('rt-bs', backend, seo, 'add the growth/SEO angle'),
      edge('rt-sc', seo, ceo, 'synthesize the final decision'),
    ],
  }
}

/**
 * Prompt → Image. A text model writes a vivid image prompt, which feeds an Image
 * node's `prompt` plug. Run the Prompt node first (free, no key) to author the
 * prompt, then run the Image node (needs a Surplus key) — or hit Run flow.
 */
function promptToImageTemplate(): StarterTemplate {
  const prompt = promptAt('p2i-prompt', { x: 60, y: 160 }, 'Prompt writer',
    'You are a prompt engineer for an IMAGE generator. Take the user\'s idea and write ONE vivid, concrete image prompt: subject, composition, lighting, lens, mood, and style. Output ONLY the prompt — no preamble.')
  const image = mediaAt('p2i-image', { x: 460, y: 120 }, 'image')
  return {
    id: 'prompt-to-image', label: 'Prompt → Image', name: 'Prompt to Image',
    description: 'A free text model authors a vivid image prompt, then feeds it into an Image node. Type your idea in the Prompt node, Run it, then Run the Image node (needs a Surplus key).',
    nodes: [prompt, image],
    edges: [mediaEdge('p2i-e1', prompt, image, 'prompt')],
  }
}

/**
 * Prompt → Viral rewrite → Video. Two chained text steps: the first drafts a
 * concept, the second rewrites it as a punchy short-form video prompt (hook,
 * motion, pacing) — then feeds a Video node. Pure-LLM + free until the Video gen.
 */
function viralVideoTemplate(): StarterTemplate {
  const idea = promptAt('vv-idea', { x: 40, y: 60 }, 'Concept',
    'You write short-form video concepts. From the user\'s topic, draft a concrete 5–10s scene: who/what, setting, the single most scroll-stopping moment.')
  const viral = promptAt('vv-viral', { x: 40, y: 300 }, 'Viral rewriter',
    'Rewrite the concept above into a punchy TEXT-TO-VIDEO prompt: a strong hook in the first second, explicit camera/motion, pacing, and mood. Make it feel viral and kinetic. Output ONLY the video prompt.', true)
  const video = mediaAt('vv-video', { x: 460, y: 180 }, 'video')
  return {
    id: 'viral-video', label: 'Prompt → Viral → Video', name: 'Viral video',
    description: 'Concept writer drafts an idea, a Viral rewriter turns it into a kinetic text-to-video prompt, then it feeds a Video node. Free to author; Video gen needs a Surplus key.',
    nodes: [idea, viral, video],
    edges: [
      edge('vv-e1', idea, viral, 'rewrite as a viral video prompt'),
      mediaEdge('vv-e2', viral, video, 'prompt'),
    ],
  }
}

/**
 * Improve my prompt → Image. A single text step that polishes whatever the user
 * types (keeps intent, adds craft) and feeds an Image node.
 */
function improvePromptTemplate(): StarterTemplate {
  const improve = promptAt('imp-prompt', { x: 60, y: 160 }, 'Prompt improver',
    'Improve and expand the user\'s image prompt. Keep their intent, then add lighting, composition, lens, materials, and style detail. Output ONLY the improved prompt.')
  const image = mediaAt('imp-image', { x: 460, y: 120 }, 'image')
  return {
    id: 'improve-prompt-image', label: 'Improve prompt → Image', name: 'Improve prompt to Image',
    description: 'Paste a rough image prompt into the Prompt node — a free text model polishes it and feeds an Image node. Run the Prompt node, then the Image node.',
    nodes: [improve, image],
    edges: [mediaEdge('imp-e1', improve, image, 'prompt')],
  }
}

/**
 * STORYBOARD — chained scenes, the FLF way.
 *
 * WORKFLOWS-RESEARCH §3.1's deliverable (text → prompt-agent → media(image) →
 * media(i2v video)), extended by the one hop that makes it a CHAIN: the last
 * frame of scene 1 becomes the start frame of scene 2
 * (LOWVRAM-META-RESEARCH DELTA ADDENDUM, "FLF CHAINING"). The app extracts that
 * frame itself when a video node is wired into another video node's `image`
 * plug — there is no extra node to place, the wire IS the instruction.
 *
 * Everything text is FREE (local router). The three media nodes target the
 * LOCAL engine: this technique exists because 8 GB cards cannot hold a long
 * single pass, and the ≤81-frame segments below are the ceiling an unpatched
 * Wan stays coherent inside (the flow-doctor says so out loud if you raise
 * them). Pick your installed local models on each media node.
 *
 * TO EXTEND: copy the "Scene 2" prompt + Video pair, wire the previous Video's
 * output into the new Video's `image` plug, and the chain grows by one scene.
 * Every added scene is another full render AND another pixel round-trip — see
 * the description for what that costs.
 */
function storyboardTemplate(): StarterTemplate {
  const idea = textAt('sb-idea', { x: 40, y: 60 }, 'Story premise',
    'A lone lighthouse keeper on a storm-lit cliff, discovering something moving in the water.')
  const stillPrompt = promptAt('sb-p-still', { x: 40, y: 260 }, 'Opening still',
    'You are an art director. From the premise above, write ONE vivid image prompt for the OPENING FRAME of the story: subject, setting, composition, lighting, lens, mood. This single frame has to establish the whole look — every later scene inherits it. Output ONLY the prompt.')
  const scene1Prompt = promptAt('sb-p-scene1', { x: 40, y: 520 }, 'Scene 1 · motion',
    'Write the MOTION for scene 1, starting from the opening frame described above: what moves, the camera move, and the pacing across about five seconds. Keep the subject, palette and setting identical — this scene has to look like the same shot continuing. Output ONLY the video prompt.')
  const scene2Prompt = promptAt('sb-p-scene2', { x: 40, y: 780 }, 'Scene 2 · motion',
    'Write the MOTION for scene 2, which begins on the LAST FRAME of scene 1. Continue the action from exactly where it left off — same subject, same palette, same setting, one new beat of story. Do not re-establish the scene or cut away. Output ONLY the video prompt.', true)

  // ≤81 frames (4n+1) per segment: 5 s x 16 fps = 80 -> 81. The consistency
  // ceiling an unpatched Wan holds inside; longer segments are silently trimmed
  // to it (and the flow-doctor warns before you find that out from the output).
  const still = mediaAt('sb-still',  { x: 470, y: 220 }, 'image', { label: 'Opening still', provider: 'local' })
  const seg1  = mediaAt('sb-scene1', { x: 470, y: 480 }, 'video', { label: 'Scene 1', provider: 'local', params: { duration: 5 } })
  const seg2  = mediaAt('sb-scene2', { x: 470, y: 740 }, 'video', { label: 'Scene 2', provider: 'local', params: { duration: 5 } })

  return {
    id: 'storyboard',
    label: 'Storyboard (chained scenes · local)',
    name: 'Storyboard',
    description:
      'Chained scenes: a still opens the story, scene 1 animates it, and scene 2 starts from scene 1\'s LAST FRAME — the app extracts that frame for you. Type your premise, pick your local models, then Run flow. Honest limits: each scene is a separate ~5 s render and a full pixel round-trip, so colour and identity drift accumulate as the chain grows, and every scene pays its own model load. Think storyboard of a few scenes, not a long film.',
    nodes: [idea, stillPrompt, scene1Prompt, scene2Prompt, still, seg1, seg2],
    edges: [
      // the text chain — one linear path, the way the router walks it
      edge('sb-e-idea', idea, stillPrompt),
      edge('sb-e-p1', stillPrompt, scene1Prompt, 'now write the motion for scene 1'),
      edge('sb-e-p2', scene1Prompt, scene2Prompt, 'now write the motion for scene 2'),
      // prompts → media (typed prompt plug)
      mediaEdge('sb-e-m-still', stillPrompt,  still, 'prompt'),
      mediaEdge('sb-e-m-s1',    scene1Prompt, seg1,  'prompt'),
      mediaEdge('sb-e-m-s2',    scene2Prompt, seg2,  'prompt'),
      // the handoffs: still → scene 1 (init frame), scene 1 → scene 2 (LAST FRAME)
      mediaEdge('sb-e-hand1', still, seg1, 'image'),
      mediaEdge('sb-e-hand2', seg1,  seg2, 'image'),
    ],
  }
}

/**
 * Agentic Studio — the flagship multi-provider board. A creative team that
 * ARGUES out a concept, then generates the image AND the video of the winner.
 *
 * It's an AGENT TEAM, not a linear workflow: a Bankr/Claude agent pitches a bold
 * concept (with MCP + web tools), an OpenGateway agent critiques it, a Surplus
 * agent directs the final call — then a Prompt node writes the image prompt
 * (→ Surplus image) and a Scenarist scripts the shots (→ a video Prompt node →
 * Surplus video). Different providers, models, tools and PERMISSIONS per agent.
 *
 * Topology note: the router follows ONE linear agent path, so the agents form a
 * single chain (debater → critic → director → image-prompt → scenarist →
 * video-prompt); the two media nodes run afterward in Phase 2 from their
 * prompt-feeder nodes. MCP + Internet are wired ONLY to the Bankr agent
 * (tool-capable); the OpenGateway critic + Surplus director stay pure-LLM so a
 * tool call can't terminate them.
 *
 * REQUIRES Bankr + OpenGateway + Surplus keys (and a funded Surplus key for the
 * actual image/video generation). Built as a showcase / testing board.
 */
function agenticStudioTemplate(): StarterTemplate {
  // Providers — three different brains.
  const provBankr   = bankrAt('as-bankr',       { x: 40,  y: 40 })
  const provOg      = opengatewayAt('as-og',    { x: 40,  y: 200 })
  const provSurplus = surplusAt('as-surplus',   { x: 40,  y: 360 })
  // Tools + permissions (different per agent).
  const mcp          = mcpAt('as-mcp',          { x: 40,  y: 520 }, 'MCP tools')
  const net          = internetAt('as-net',     { x: 40,  y: 660 }, 'Internet')
  const roleResearch = roleAt('as-role-research', { x: 40, y: 800 },  'Researcher (web + mcp)', ['Read', 'Glob', 'Grep', 'WebFetch'])
  const roleEdit     = roleAt('as-role-edit',     { x: 40, y: 940 },  'File editor',            ['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  const folder       = folderAt('as-folder',      { x: 40, y: 1080 }, 'Script workspace')

  // Agents — a LINEAR debate chain (router follows one path; media runs after).
  const debater = agentAt('as-debater', { x: 380, y: 60 }, 'Visionary · Bankr',
    'You are the Visionary on a creative team. From the user\'s topic (or pick a striking one yourself if none is given), pitch ONE bold, specific concept for a short visual piece: a single hero image plus a few seconds of video. Be concrete and opinionated. Use web/MCP tools if they help ground it in something real or trending. End with a one-line thesis the others will challenge.')
  const critic = agentAt('as-critic', { x: 380, y: 320 }, 'Skeptic · OpenGateway',
    'You are the Skeptic. Read the Visionary\'s concept above and argue against it: what is clichéd, unclear, or will not read on screen. Then propose the single change that makes it sharper. Be blunt and specific — this is a debate, not a rubber stamp.')
  const director = agentAt('as-director', { x: 380, y: 580 }, 'Director · Surplus',
    'You are the Director and final decision-maker. Read the Visionary\'s pitch and the Skeptic\'s critique above, resolve the disagreement, and lock ONE concept: final subject, mood, setting, and the single hero shot. Be decisive and concise — everything downstream builds on this.')
  const promptImage = promptAt('as-prompt-img', { x: 760, y: 320 }, 'Image prompt',
    'Write one vivid image-generation prompt for the Director\'s locked hero shot: subject, composition, lighting, lens, style, mood.')
  const scenario = agentAt('as-scenario', { x: 760, y: 600 }, 'Scenarist · Bankr',
    'You are the Scenarist. From the Director\'s locked concept above, write a tight shot-by-shot script for a 5-10 second video: 3-5 beats, each with subject, camera move, and pacing. Keep it kinetic and shootable. Output the script only.')
  const promptVideo = promptAt('as-prompt-vid', { x: 1120, y: 600 }, 'Video prompt',
    'Turn the script above into one kinetic text-to-video prompt: a hook in the first second, explicit camera and motion, pacing, and mood.')

  // Media outputs (Surplus). Run in Phase 2 from their prompt-feeder nodes.
  const image = mediaAt('as-image', { x: 1120, y: 300 }, 'image')
  const video = mediaAt('as-video', { x: 1480, y: 560 }, 'video')

  return {
    id: 'agentic-studio',
    label: 'Agentic Studio (multi-provider · debate → image + video)',
    name: 'Agentic Studio',
    description:
      'A creative team that ARGUES, then creates. A Bankr agent pitches, an OpenGateway agent critiques, a Surplus agent directs — then a Prompt node writes the image prompt (Surplus image) and a Scenarist scripts a video (Surplus video). Different providers, models, MCP/web tools and permissions per agent. Needs Bankr + OpenGateway + Surplus keys (funded Surplus key for media). Showcase / testing board.',
    nodes: [
      provBankr, provOg, provSurplus,
      mcp, net, roleResearch, roleEdit, folder,
      debater, critic, director, promptImage, scenario, promptVideo,
      image, video,
    ],
    edges: [
      // providers → agents (each agent draws its model from one provider edge)
      edge('as-e-pb',  provBankr,   debater),
      edge('as-e-po',  provOg,      critic),
      edge('as-e-ps',  provSurplus, director),
      edge('as-e-pb2', provBankr,   scenario),
      // tools + permissions: web/mcp + researcher → debater; folder/editor → scenarist
      edge('as-e-mcp', mcp,          debater),
      edge('as-e-net', net,          debater),
      edge('as-e-rr',  roleResearch, debater),
      edge('as-e-re',  roleEdit,     scenario),
      edge('as-e-fd',  folder,       scenario),
      // debate + build chain (LINEAR — one outgoing agent edge per agent)
      edge('as-e-dc',    debater,     critic,      'attack the weak points'),
      edge('as-e-cd',    critic,      director,    'pick the winning direction'),
      edge('as-e-dp',    director,    promptImage, 'write the image prompt for the chosen concept'),
      edge('as-e-pi-sc', promptImage, scenario,    'now write the shot-by-shot script for the concept'),
      edge('as-e-sc-pv', scenario,    promptVideo, 'turn the script into a kinetic video prompt'),
      // media phase (typed prompt plug)
      mediaEdge('as-e-img', promptImage, image, 'prompt'),
      mediaEdge('as-e-vid', promptVideo, video, 'prompt'),
    ],
  }
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  agenticStudioTemplate(),
  storyboardTemplate(),
  promptToImageTemplate(),
  viralVideoTemplate(),
  improvePromptTemplate(),
  expertRoundtableTemplate(),
  codeHelperTemplate(),
  buildReviewTemplate(),
  chain(
    'writer-reviewer',
    'Writer to Reviewer',
    'Writer drafts, Reviewer critiques and improves it.',
    'Writer',
    'Reviewer',
    'needs review',
  ),
  chain(
    'research-summarize',
    'Research to Summary',
    'Researcher gathers points, Summarizer condenses them.',
    'Researcher',
    'Summarizer',
    'summarize findings',
  ),
  chain(
    'code-review',
    'Code to Review',
    'Coder writes the code, Reviewer checks it for bugs.',
    'Coder',
    'Reviewer',
    'review the code',
  ),
]
