// apps/desktop/test/unit/gnapClientAsyncIO.test.ts
//
// Audit M1.5: gnap-client's filesystem layer was converted from synchronous
// fs (readFileSync/writeFileSync/existsSync/mkdirSync/readdirSync) to async
// node:fs/promises so the Electron main process never blocks the event loop in
// this hot path. The public GnapClient method signatures were already async,
// so this is a behaviour-preserving internal change.
//
// These tests pin that behaviour: an async write→read→write→read round-trip
// against a real temp dir must round-trip the data byte-for-byte and survive
// re-reads, exactly as the sync version did. We run in pure-local mode (no
// `origin` remote configured) so commitAndPush commits locally and returns ok
// without a network push.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGnapClient, type GnapTask } from '../../electron/services/gnap-client'

const client = createGnapClient()

// Bring up a bare git repo (pure-local mode: no `origin`) so commitAndPush
// commits locally and resolves ok. We git-init directly rather than calling
// client.initSwarm() because the mutating helpers (createTask/registerAgent)
// self-create their `.gnap/<kind>` dirs via writeJson's recursive mkdir — that
// is exactly the async write→read path under test, and it isolates these tests
// from initSwarm's separate bootstrap concerns.
function gitInit(dir: string): void {
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 'test@tachidesk.local'])
  run(['config', 'user.name', 'tachi-test'])
}

function makeTask(id: string): GnapTask {
  return {
    id,
    title: `task ${id}`,
    assigned_to: [],
    state: 'backlog',
    created_by: 'tester',
    created_at: new Date('2026-06-16T00:00:00.000Z').toISOString(),
  }
}

describe('gnap-client async fs round-trip (audit M1.5)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gnap-async-'))
    gitInit(repo)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('createTask writes and listTasks reads the same task back', async () => {
    const task = makeTask('t-1')
    await client.createTask(repo, task)

    const listed = await client.listTasks(repo)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(task)

    // Raw on-disk JSON must match what we wrote (2-space indent + trailing nl).
    const onDisk = readFileSync(
      join(repo, '.gnap', 'tasks', 't-1.json'),
      'utf8',
    )
    expect(onDisk.endsWith('\n')).toBe(true)
    expect(JSON.parse(onDisk)).toEqual(task)
  })

  it('write → read → write → read preserves data across mutations', async () => {
    const task = makeTask('t-2')
    await client.createTask(repo, task)

    // First read.
    const read1 = await client.listTasks(repo, { state: 'backlog' })
    expect(read1.map((t) => t.id)).toEqual(['t-2'])

    // Second write: state transition re-reads then re-writes the file.
    await client.updateTaskState(repo, 't-2', 'in_progress', 'tester')

    // Final read: the new state survives, every other field intact.
    const read2 = await client.listTasks(repo)
    expect(read2).toHaveLength(1)
    expect(read2[0]).toEqual({ ...task, state: 'in_progress' })

    // The old-state filter must now return nothing.
    const backlog = await client.listTasks(repo, { state: 'backlog' })
    expect(backlog).toHaveLength(0)
  })

  it('agents round-trip through registerAgent / listAgents', async () => {
    await client.registerAgent(repo, {
      id: 'a-1',
      name: 'Alpha',
      role: 'worker',
      type: 'ai',
      status: 'active',
    })
    const agents = await client.listAgents(repo)
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ id: 'a-1', name: 'Alpha', status: 'active' })

    // Re-register (upsert) flips status; the re-read reflects it.
    await client.updateAgentStatus(repo, 'a-1', 'stopped')
    const after = await client.listAgents(repo)
    expect(after[0].status).toBe('stopped')
  })

  it('listTasks on a fresh swarm returns [] (async empty-dir probe)', async () => {
    // listJsonFiles now probes existence via fs/promises access(); an empty
    // tasks dir must resolve to an empty list, not throw.
    expect(await client.listTasks(repo)).toEqual([])
    expect(await client.listRuns(repo)).toEqual([])
    expect(await client.listMessages(repo)).toEqual([])
  })
})
