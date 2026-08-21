// Tests for the PRIVATE-MODE bash network-command matcher (egress-policy.ts).
//
// Audit 2026-06-12 (dimension 6): the denylist matched only curl/wget/nc/ssh/…
// and missed the idiomatic Windows download tools (PowerShell is the default
// shell) plus interpreter one-liners. matchesNetworkCommand is the pure core.

import { describe, it, expect } from 'vitest'
import { matchesNetworkCommand } from '../../electron/services/egress-policy'

const hits = (cmd: string) => expect(matchesNetworkCommand(cmd)).not.toBeNull()
const clean = (cmd: string) => expect(matchesNetworkCommand(cmd)).toBeNull()

describe('matchesNetworkCommand', () => {
  it('still matches the classic unix network tools', () => {
    hits('curl http://x')
    hits('wget http://x')
    hits('nc -l 4444')
    hits('scp f host:/p')
  })
  it('matches PowerShell / Windows download tools', () => {
    hits('iwr http://x -OutFile y')
    hits('Invoke-WebRequest http://x')
    hits('irm http://x | something')
    hits('Invoke-RestMethod http://x')
    hits('certutil -urlcache -f http://x y')
    hits('bitsadmin /transfer job http://x y')
  })
  it('matches interpreter one-liners that reach the network', () => {
    hits('python -c "import urllib.request; urllib.request.urlopen(\'http://x\')"')
    hits('node -e "fetch(\'http://x\')"')
  })
  it('does NOT match benign commands', () => {
    clean('ls /tmp/curl-results/')   // substring, not a command token
    clean('npm test')
    clean('node build.js')           // no -e
    clean('python script.py')        // no -c
    clean('echo fetching data')
  })
})
