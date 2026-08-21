// Preview media blob-bootstrap injection (pure): served docs with assets/
// media get the fetch→blob swap script; everything else passes untouched.
import { describe, it, expect } from 'vitest'
import { injectMediaBlobBootstrap, hasMediaBlobBootstrap } from '../../electron/services/util/preview-inject'

const PAGE = '<!doctype html><html><head></head><body><video src="assets/0.mp4" muted></video><script>var x=1</script></body></html>'

describe('injectMediaBlobBootstrap', () => {
  it('injects before </body> when the doc references assets/ media', () => {
    const out = injectMediaBlobBootstrap(PAGE)
    expect(out).toContain('data-tachi-media-blob')
    expect(out.indexOf('data-tachi-media-blob')).toBeLessThan(out.indexOf('</body>'))
    expect(out.indexOf('data-tachi-media-blob')).toBeGreaterThan(out.indexOf('var x=1'))
  })
  it('appends when there is no </body>', () => {
    const out = injectMediaBlobBootstrap('<video src="assets/a.webm">')
    expect(out.endsWith('</script>')).toBe(true)
  })
  it('no-ops without assets/ media references', () => {
    const plain = '<!doctype html><body><h1>hi</h1><img src="logo.png"></body>'
    expect(injectMediaBlobBootstrap(plain)).toBe(plain)
  })
  it('is idempotent', () => {
    const once = injectMediaBlobBootstrap(PAGE)
    expect(injectMediaBlobBootstrap(once)).toBe(once)
    expect(hasMediaBlobBootstrap(once)).toBe(true)
  })
  it('handles single-quoted and source-child references', () => {
    expect(injectMediaBlobBootstrap("<body><audio><source src='assets/t.mp3'></audio></body>")).toContain('data-tachi-media-blob')
  })
  it('tolerates empty input', () => {
    expect(injectMediaBlobBootstrap('')).toBe('')
  })
})
