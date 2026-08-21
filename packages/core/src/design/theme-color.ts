// packages/core/src/design/theme-color.ts
//
// Pure colour math shared by the theme EXTRACTOR (theme-extract.ts) and the
// theme VALIDATOR (theme-validate.ts). No DOM, no dependencies — every helper
// is a plain function over sRGB triples so both can run in the main process,
// the renderer and node tests alike.
//
// Scope note: this deliberately implements only what the theme pipeline needs
// (parse the colour notations a design mockup realistically ships, WCAG 2.x
// relative luminance / contrast, and hue-preserving lightness nudges). It is
// NOT a general colour library — no LAB, no gamut mapping, no colour spaces
// beyond sRGB/HSL.

/** An opaque sRGB colour, channels in 0..255. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** HSL, h in 0..360, s/l in 0..1. */
export interface Hsl {
  h: number
  s: number
  l: number
}

/**
 * The handful of CSS named colours a generated mockup actually uses. A full
 * named-colour table would be dead weight: anything outside this list simply
 * fails to parse, and the caller reports "could not check" rather than
 * guessing.
 */
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  aqua: '#00ffff',
  cyan: '#00ffff',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)
const round255 = (n: number) => clamp(Math.round(n), 0, 255)

/**
 * Parse a CSS colour into sRGB. Supports #rgb / #rgba / #rrggbb / #rrggbbaa,
 * rgb()/rgba() and hsl()/hsla() (comma OR space separated, with or without a
 * `/ alpha` part), plus the named colours above. Alpha is PARSED BUT DROPPED —
 * contrast maths needs an opaque colour, and every palette slot in the 24-var
 * contract is opaque by convention.
 *
 * Returns null for anything else (`transparent`, `currentColor`, gradients,
 * unresolved `var(...)`) so callers can skip rather than invent a value.
 */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase()
  if (!s) return null

  const named = NAMED_COLORS[s]
  if (named) return parseColor(named)

  if (s.startsWith('#')) {
    const hex = s.slice(1)
    if (!/^[0-9a-f]+$/.test(hex)) return null
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: parseInt(hex[0]! + hex[0]!, 16),
        g: parseInt(hex[1]! + hex[1]!, 16),
        b: parseInt(hex[2]! + hex[2]!, 16),
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      }
    }
    return null
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s)
  if (!fn) return null
  const kind = fn[1]!
  const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null

  const num = (raw: string, pctBase: number): number | null => {
    const m = /^(-?\d*\.?\d+)(%|deg|turn|rad)?$/.exec(raw)
    if (!m) return null
    let v = Number(m[1])
    if (!Number.isFinite(v)) return null
    if (m[2] === '%') v = (v / 100) * pctBase
    else if (m[2] === 'turn') v *= 360
    else if (m[2] === 'rad') v = (v * 180) / Math.PI
    return v
  }

  if (kind.startsWith('rgb')) {
    const r = num(parts[0]!, 255)
    const g = num(parts[1]!, 255)
    const b = num(parts[2]!, 255)
    if (r === null || g === null || b === null) return null
    return { r: round255(r), g: round255(g), b: round255(b) }
  }

  const h = num(parts[0]!, 360)
  const sat = num(parts[1]!, 100)
  const li = num(parts[2]!, 100)
  if (h === null || sat === null || li === null) return null
  return hslToRgb({ h, s: clamp(sat / 100, 0, 1), l: clamp(li / 100, 0, 1) })
}

/** Lower-case `#rrggbb`. */
export function toHex(c: Rgb): string {
  const part = (n: number) => round255(n).toString(16).padStart(2, '0')
  return `#${part(c.r)}${part(c.g)}${part(c.b)}`
}

export function rgbToHsl(c: Rgb): Hsl {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

export function hslToRgb(c: Hsl): Rgb {
  const h = ((c.h % 360) + 360) % 360
  const s = clamp(c.s, 0, 1)
  const l = clamp(c.l, 0, 1)
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - chroma / 2
  let rgb: [number, number, number]
  if (h < 60) rgb = [chroma, x, 0]
  else if (h < 120) rgb = [x, chroma, 0]
  else if (h < 180) rgb = [0, chroma, x]
  else if (h < 240) rgb = [0, x, chroma]
  else if (h < 300) rgb = [x, 0, chroma]
  else rgb = [chroma, 0, x]
  return {
    r: round255((rgb[0] + m) * 255),
    g: round255((rgb[1] + m) * 255),
    b: round255((rgb[2] + m) * 255),
  }
}

/** WCAG 2.x relative luminance (sRGB, D65). */
export function relativeLuminance(c: Rgb): number {
  const chan = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b)
}

/** WCAG contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** True when a colour reads as "dark" (a dark theme's base background). */
export function isDark(c: Rgb): boolean {
  return relativeLuminance(c) < 0.18
}

/** Linear blend: t = 0 returns `a`, t = 1 returns `b`. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1)
  return {
    r: round255(a.r + (b.r - a.r) * k),
    g: round255(a.g + (b.g - a.g) * k),
    b: round255(a.b + (b.b - a.b) * k),
  }
}

/** Rotate hue, keeping saturation and lightness (used to invent an alt accent). */
export function rotateHue(c: Rgb, degrees: number): Rgb {
  const hsl = rgbToHsl(c)
  return hslToRgb({ ...hsl, h: hsl.h + degrees })
}

/**
 * Move `color` toward white (on a dark base) or black (on a light base) by
 * `amount` (0..1). One "step" of surface elevation.
 */
export function shade(color: Rgb, amount: number, dark = isDark(color)): Rgb {
  const target: Rgb = dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
  return mix(color, target, Math.abs(amount))
}

/**
 * Nearest-HUE contrast fix: keep the foreground's hue and saturation, walk its
 * LIGHTNESS in the direction that increases contrast against `bg` and return
 * the first value that reaches `target`. Returns null when even pure
 * white/black cannot reach the target (only possible for mid-luminance
 * backgrounds and very high targets).
 *
 * "Nearest" is literal: the scan starts at the current lightness and moves in
 * 1% steps, so the suggestion is the smallest hue-preserving change that
 * passes.
 */
export function suggestContrastFix(fg: Rgb, bg: Rgb, target: number): string | null {
  if (contrastRatio(fg, bg) >= target) return null
  const hsl = rgbToHsl(fg)
  const dir = relativeLuminance(bg) < 0.5 ? 1 : -1
  for (let i = 1; i <= 100; i++) {
    const l = clamp(hsl.l + (dir * i) / 100, 0, 1)
    const candidate = hslToRgb({ ...hsl, l })
    if (contrastRatio(candidate, bg) >= target) return toHex(candidate)
    if (l === 0 || l === 1) break
  }
  // Last resort: the opposite direction (a light-on-light pair may be fixable
  // by going darker even though the background reads "light", and vice versa).
  for (let i = 1; i <= 100; i++) {
    const l = clamp(hsl.l - (dir * i) / 100, 0, 1)
    const candidate = hslToRgb({ ...hsl, l })
    if (contrastRatio(candidate, bg) >= target) return toHex(candidate)
    if (l === 0 || l === 1) break
  }
  return null
}
