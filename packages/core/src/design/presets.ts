// packages/core/src/design/presets.ts
//
// Curated brand presets for the Design tab. Each is a compact DesignSpec the
// system prompt renders into design-system instructions, so a generated UI
// looks intentionally *designed* (a real palette, type pairing, radius, density,
// motion) instead of generic. Inspired by the public design-systems libraries in
// open-design / openpencil — but these are our own hand-authored specs, not
// copied brand assets. Order here is the picker display order.

import type { BrandPreset } from './types.js'

export const BRAND_PRESETS: BrandPreset[] = [
  {
    id: 'tachi-brutalist',
    label: 'TACHI Brutalist',
    description: 'Mono type, hard 2px borders, no radius — the app\'s own look.',
    spec: {
      vibe: 'Brutalist developer tool: monospace, hard 2px borders, hard offset shadows, zero border-radius, high-contrast, terminal energy.',
      colors: { bg: '#0a0a0a', surface: '#141414', text: '#f5f5f5', muted: '#8a8a8a', accent: '#39ff14', accentText: '#0a0a0a', border: '#2a2a2a' },
      fonts: { heading: 'Space Grotesk', body: 'JetBrains Mono', mono: 'JetBrains Mono' },
      radius: 'none', density: 'compact', motion: 'subtle',
    },
  },
  {
    id: 'linear',
    label: 'Linear',
    description: 'Dark, refined, subtle gradients and crisp small type.',
    spec: {
      vibe: 'Modern SaaS like Linear: dark slate canvas, restrained indigo accent, fine 1px borders, small precise type, subtle gradient glows, calm and premium.',
      colors: { bg: '#08090d', surface: '#101218', text: '#e6e7ea', muted: '#8a8f98', accent: '#5e6ad2', accentText: '#ffffff', border: '#23262e' },
      fonts: { heading: 'Inter', body: 'Inter' },
      radius: 'md', density: 'comfortable', motion: 'subtle',
    },
  },
  {
    id: 'stripe',
    label: 'Stripe',
    description: 'Clean light surfaces, blurple accent, generous whitespace.',
    spec: {
      vibe: 'Stripe-grade clarity: light, airy, generous whitespace, blurple accent, soft shadows, confident sans type, gradient hero accents.',
      colors: { bg: '#ffffff', surface: '#f6f9fc', text: '#0a2540', muted: '#425466', accent: '#635bff', accentText: '#ffffff', border: '#e3e8ee' },
      fonts: { heading: 'Inter', body: 'Inter' },
      radius: 'lg', density: 'spacious', motion: 'subtle',
    },
  },
  {
    id: 'vercel',
    label: 'Vercel',
    description: 'High-contrast black & white, geometric sans, sharp.',
    spec: {
      vibe: 'Vercel monochrome: pure black/white, high contrast, geometric sans, thin borders, minimal color, crisp and confident.',
      colors: { bg: '#000000', surface: '#0a0a0a', text: '#ededed', muted: '#888888', accent: '#ffffff', accentText: '#000000', border: '#262626' },
      fonts: { heading: 'Geist', body: 'Geist', mono: 'Geist Mono' },
      radius: 'md', density: 'comfortable', motion: 'subtle',
    },
  },
  {
    id: 'apple',
    label: 'Apple',
    description: 'Light, soft, big type, lots of air, frosted surfaces.',
    spec: {
      vibe: 'Apple marketing page: huge bold display type, deep blacks on white, lots of breathing room, frosted-glass surfaces, smooth scroll-reveal motion.',
      colors: { bg: '#ffffff', surface: '#f5f5f7', text: '#1d1d1f', muted: '#6e6e73', accent: '#0071e3', accentText: '#ffffff', border: '#d2d2d7' },
      fonts: { heading: 'SF Pro Display, Inter', body: 'SF Pro Text, Inter' },
      radius: 'xl', density: 'spacious', motion: 'expressive',
    },
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Warm neutral, editorial serif headings, friendly.',
    spec: {
      vibe: 'Notion docs: warm off-white, editorial serif headings over humanist sans body, subtle borders, friendly and calm, content-first.',
      colors: { bg: '#ffffff', surface: '#f7f6f3', text: '#37352f', muted: '#787774', accent: '#2383e2', accentText: '#ffffff', border: '#e9e9e7' },
      fonts: { heading: 'Lora', body: 'Inter' },
      radius: 'sm', density: 'comfortable', motion: 'none',
    },
  },
  {
    id: 'glass',
    label: 'Glassmorphism',
    description: 'Frosted translucent cards over a vivid gradient.',
    spec: {
      vibe: 'Glassmorphism: vivid animated gradient background, frosted translucent cards (backdrop-blur, 1px white border at low opacity), soft glows, playful.',
      colors: { bg: '#1a1340', surface: 'rgba(255,255,255,0.08)', text: '#f5f3ff', muted: '#c4b5fd', accent: '#a78bfa', accentText: '#1a1340', border: 'rgba(255,255,255,0.18)' },
      fonts: { heading: 'Poppins', body: 'Inter' },
      radius: 'xl', density: 'spacious', motion: 'expressive',
    },
  },
  {
    id: 'retro-terminal',
    label: 'Retro Terminal',
    description: 'Phosphor green on black, scanlines, CRT energy.',
    spec: {
      vibe: 'Retro CRT terminal: phosphor green on near-black, monospace everywhere, faint scanline overlay, blinking cursor accents, 80s computer vibe.',
      colors: { bg: '#020a02', surface: '#0a140a', text: '#33ff66', muted: '#1f8f3f', accent: '#9dff00', accentText: '#020a02', border: '#0f3d18' },
      fonts: { heading: 'IBM Plex Mono', body: 'IBM Plex Mono', mono: 'IBM Plex Mono' },
      radius: 'none', density: 'compact', motion: 'subtle',
    },
  },
  {
    id: 'neon-cyber',
    label: 'Neon Cyber',
    description: 'Dark cyberpunk with magenta/cyan neon glows.',
    spec: {
      vibe: 'Cyberpunk neon: near-black canvas, magenta + cyan neon accents with glow, sharp angular cards, futuristic display type, energetic.',
      colors: { bg: '#0b0014', surface: '#15071f', text: '#f0e6ff', muted: '#9a7bb5', accent: '#ff2bd6', accentText: '#0b0014', border: '#3a1252' },
      fonts: { heading: 'Orbitron', body: 'Rajdhani' },
      radius: 'sm', density: 'comfortable', motion: 'expressive',
    },
  },
  {
    id: 'editorial-serif',
    label: 'Editorial',
    description: 'Magazine layout, dramatic serif, ink on cream.',
    spec: {
      vibe: 'Editorial magazine: cream paper, dramatic high-contrast serif display, generous columns, fine rules, restrained accent, print-quality typography.',
      colors: { bg: '#faf7f0', surface: '#ffffff', text: '#1a1a1a', muted: '#6b6b6b', accent: '#b3402f', accentText: '#ffffff', border: '#e4ded0' },
      fonts: { heading: 'Playfair Display', body: 'Source Serif Pro' },
      radius: 'none', density: 'spacious', motion: 'none',
    },
  },
]

/** Look a preset up by id. */
export function getPreset(id: string | null | undefined): BrandPreset | undefined {
  if (!id) return undefined
  return BRAND_PRESETS.find(p => p.id === id)
}
