// packages/core/src/design/types.ts
//
// Pure, renderer-safe types for the Design tab (TACHI Design — the open-source
// Claude-Design surface). A DesignSpec is a compact, model-readable design
// system; a BrandPreset wraps one with a label so the picker can offer curated
// looks. Both are plain data — no I/O, no Node imports — so they import cleanly
// into the renderer via the `@tachi/core/src/design/...` subpath AND the main
// process via the `@tachi/core` barrel.

/** Corner-radius scale label (mapped to concrete px in the system prompt). */
export type RadiusScale = 'none' | 'sm' | 'md' | 'lg' | 'xl'

/** Spacing density. */
export type Density = 'compact' | 'comfortable' | 'spacious'

/** Motion intensity the generated UI should use. */
export type Motion = 'none' | 'subtle' | 'expressive'

/** A compact, model-readable design system. */
export interface DesignSpec {
  /** One-line brand/voice description injected verbatim into the system prompt. */
  vibe: string
  /** Core palette as CSS-ready hex tokens. */
  colors: {
    bg: string
    surface: string
    text: string
    muted: string
    accent: string
    accentText: string
    border: string
  }
  /** Font families (web-safe names or Google-Fonts families). */
  fonts: {
    heading: string
    body: string
    mono?: string
  }
  radius: RadiusScale
  density: Density
  motion: Motion
}

/** A curated, named design system shown in the Design tab's preset picker. */
export interface BrandPreset {
  /** Stable id (kebab-case). */
  id: string
  /** Display label. */
  label: string
  /** Short one-liner shown under the label in the picker. */
  description: string
  spec: DesignSpec
}
