import { createServer } from 'net'
import type { AddressInfo } from 'net'

/**
 * Returns a free TCP port on 127.0.0.1.
 * Tries `preferred` first; if taken, asks the OS for any available port.
 * Pure Node.js — no Electron dependency.
 */
export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()

    srv.listen(preferred, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(err => (err ? reject(err) : resolve(port)))
    })

    srv.on('error', () => {
      // Preferred port is taken — ask OS for any free port
      const fallback = createServer()
      fallback.listen(0, '127.0.0.1', () => {
        const port = (fallback.address() as AddressInfo).port
        fallback.close(err => (err ? reject(err) : resolve(port)))
      })
      fallback.on('error', reject)
    })
  })
}
