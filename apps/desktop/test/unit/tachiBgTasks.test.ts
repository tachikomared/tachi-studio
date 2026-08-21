// Background bash tasks: start → poll output → kill → session cleanup.
import { describe, it, expect } from 'vitest'
import { executeTool, killAllBgTasks, type ToolContext } from '../../electron/services/tachi/tools'
import { tmpdir } from 'node:os'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('bash background tasks', () => {
  it('starts a task, tails output, reports exit', async () => {
    const ctx: ToolContext = { workspaceRoot: tmpdir() }
    const start = await executeTool('bash', { command: 'node -e "console.log(\'BG-HELLO\')"', background: true }, ctx)
    expect(start.isError).toBe(false)
    expect(start.output).toContain('bg-1')
    await wait(1500)
    const out = await executeTool('bash_output', { task_id: 'bg-1' }, ctx)
    expect(out.isError).toBe(false)
    expect(out.output).toContain('BG-HELLO')
    expect(out.output).toContain('EXITED')
    killAllBgTasks(ctx)
  })

  it('kills a long-running task and cleans up at session end', async () => {
    const ctx: ToolContext = { workspaceRoot: tmpdir() }
    await executeTool('bash', { command: 'node -e "setInterval(()=>console.log(\'tick\'),200)"', background: true }, ctx)
    await wait(800)
    const running = await executeTool('bash_output', { task_id: 'bg-1' }, ctx)
    expect(running.output).toContain('RUNNING')
    const killed = await executeTool('bash_kill', { task_id: 'bg-1' }, ctx)
    expect(killed.isError).toBe(false)
    await wait(600)
    const after = await executeTool('bash_output', { task_id: 'bg-1' }, ctx)
    expect(after.output).not.toContain('RUNNING')
    killAllBgTasks(ctx)
    expect(ctx.bgTasks?.size ?? 0).toBe(0)
  })

  it('unknown task id errors helpfully; destructive command still refused in background', async () => {
    const ctx: ToolContext = { workspaceRoot: tmpdir() }
    const miss = await executeTool('bash_output', { task_id: 'bg-9' }, ctx)
    expect(miss.isError).toBe(true)
    const evil = await executeTool('bash', { command: 'rm -rf /', background: true }, ctx)
    expect(evil.isError).toBe(true)
  })
})
