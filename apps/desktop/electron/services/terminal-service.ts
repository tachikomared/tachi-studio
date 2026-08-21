import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'

interface PtySession { pty: pty.IPty }
const sessions = new Map<string, PtySession>()

function getDefaultShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    try {
      require('child_process').execFileSync('where.exe', ['pwsh.exe'], { timeout: 2000 })
      return { shell: 'pwsh.exe', args: [] }
    } catch {}
    return { shell: 'powershell.exe', args: [] }
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { shell, args: [] }
}

export function createTerminal(win: BrowserWindow, id: string) {
  if (sessions.has(id)) return
  const { shell, args } = getDefaultShell()

  // Windows: force the winpty backend. node-pty's default ConPTY backend spawns
  // a helper (conpty_console_list_agent.js) that calls AttachConsole — which
  // fails in a GUI Electron app with no attached console and crashes with
  // "AttachConsole failed", spamming the log. winpty doesn't use that agent.
  const spawnOpts: pty.IPtyForkOptions & { useConpty?: boolean } = {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME ?? process.cwd(),
    env: process.env as Record<string, string>,
  }
  if (process.platform === 'win32') spawnOpts.useConpty = false

  let p: pty.IPty
  try {
    p = pty.spawn(shell, args, spawnOpts)
  } catch (err) {
    // Surface the failure to the terminal pane instead of crashing the main process.
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:data', {
        id,
        data: `\r\nFailed to start shell (${shell}): ${err instanceof Error ? err.message : String(err)}\r\n`,
      })
    }
    return
  }

  p.onData(data => { if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data }) })
  p.onExit(() => { sessions.delete(id); if (!win.isDestroyed()) win.webContents.send('terminal:exit', { id }) })
  sessions.set(id, { pty: p })
}

export function writeTerminal(id: string, data: string) {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  sessions.get(id)?.pty.resize(cols, rows)
}

export function killTerminal(id: string) {
  sessions.get(id)?.pty.kill()
  sessions.delete(id)
}
