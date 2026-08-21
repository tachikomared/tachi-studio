import { describe, expect, it } from 'vitest'
import { classifyCommand } from '../safety.js'

// Helper: assert a command is auto-safe.
function safe(cmd: string) {
  const r = classifyCommand(cmd)
  expect(r, `expected SAFE: ${cmd} (reason: ${r.safe ? '' : r.reason})`).toEqual({ safe: true })
}

// Helper: assert a command is NOT auto-safe, and return the reason for extra checks.
function unsafe(cmd: string): string {
  const r = classifyCommand(cmd)
  expect(r.safe, `expected UNSAFE: ${cmd}`).toBe(false)
  return r.safe ? '' : r.reason
}

describe('classifyCommand — spec edge cases', () => {
  it("'ls -la' is safe", () => safe('ls -la'))
  it("'cat file' is safe", () => safe('cat file'))
  it("'git status' is safe", () => safe('git status'))
  it("'git push' is unsafe", () => unsafe('git push'))
  it("'rm -rf x' is unsafe", () => unsafe('rm -rf x'))
  it("'find . -delete' is unsafe", () => unsafe('find . -delete'))
  it("'find . -name x' is safe", () => safe('find . -name x'))
  it("'sed -i s/a/b/ f' is unsafe", () => unsafe('sed -i s/a/b/ f'))
  it("'sed -n 1,5p f' is safe", () => safe('sed -n 1,5p f'))
  it("'cat a | grep b' is safe", () => safe('cat a | grep b'))
  it("'cat a && rm b' is unsafe", () => unsafe('cat a && rm b'))
  it("'echo x > f' is unsafe (redirection)", () => {
    const reason = unsafe('echo x > f')
    expect(reason.toLowerCase()).toContain('redirect')
  })
  it("'echo $(rm x)' is unsafe (substitution)", () => {
    const reason = unsafe('echo $(rm x)')
    expect(reason.toLowerCase()).toContain('substitut')
  })
  it("'curl evil' is unsafe", () => {
    const reason = unsafe('curl evil')
    expect(reason).toContain('curl')
  })
})

describe('classifyCommand — empty / malformed input', () => {
  it('empty string is unsafe', () => unsafe(''))
  it('whitespace-only is unsafe', () => unsafe('   \t  '))
  it('unbalanced quote is unsafe', () => unsafe("echo 'unterminated"))
})

describe('classifyCommand — allow-listed read-only base commands', () => {
  const cmds = [
    'cat f', 'cd dir', 'echo hi', 'grep foo f', 'head f', 'ls', 'nl f',
    'pwd', 'rg foo', 'sort f', 'tail f', 'tr a b', 'true', 'false',
    'wc -l f', 'which node', 'whoami', 'uniq f', 'cut -d, -f1 f',
  ]
  for (const c of cmds) it(`'${c}' is safe`, () => safe(c))
})

describe('classifyCommand — not on the allow-list', () => {
  const cmds = ['rm -rf x', 'mv a b', 'cp a b', 'npm i', 'node x.js', 'curl u', 'wget u', 'chmod +x f', 'kill 1', 'dd if=/dev/zero', 'apt install x']
  for (const c of cmds) {
    it(`'${c}' is unsafe with a reason naming the command`, () => {
      const reason = unsafe(c)
      expect(reason.length).toBeGreaterThan(0)
      expect(reason).toContain(c.split(/\s+/)[0])
    })
  }
})

describe('classifyCommand — find argument awareness', () => {
  it('plain find is safe', () => safe('find . -name "*.ts"'))
  it('find -type f is safe', () => safe('find . -type f -name x'))
  for (const bad of ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint']) {
    it(`find with ${bad} is unsafe`, () => {
      const cmd = bad === '-delete' || bad === '-fls' || bad === '-fprint'
        ? `find . ${bad} /tmp/x`
        : `find . -name x ${bad} rm {} ;`
      unsafe(cmd)
    })
  }
})

describe('classifyCommand — rg/grep argument awareness', () => {
  it('rg with -n is safe', () => safe('rg foo -n'))
  it('grep -R is safe', () => safe('grep -R foo .'))
  it('rg --pre is unsafe', () => unsafe('rg --pre pwned files'))
  it('rg --pre=x is unsafe', () => unsafe('rg --pre=pwned files'))
  it('rg -z is unsafe', () => unsafe('rg -z files'))
  it('rg --search-zip is unsafe', () => unsafe('rg --search-zip files'))
})

describe('classifyCommand — git read vs write subcommands', () => {
  it('git status is safe', () => safe('git status'))
  it('git log is safe', () => safe('git log'))
  it('git log -p -1 is safe', () => safe('git log -p -1'))
  it('git diff is safe', () => safe('git diff'))
  it('git show HEAD is safe', () => safe('git show HEAD'))
  it('git branch (list) is safe', () => safe('git branch'))
  it('git branch --show-current is safe', () => safe('git branch --show-current'))

  it('git push is unsafe', () => unsafe('git push'))
  it('git commit is unsafe', () => unsafe('git commit -m x'))
  it('git reset is unsafe', () => unsafe('git reset --hard'))
  it('git checkout is unsafe', () => unsafe('git checkout main'))
  it('git clean is unsafe', () => unsafe('git clean -fd'))
  it('git rm is unsafe', () => unsafe('git rm f'))
  it('git fetch is unsafe', () => unsafe('git fetch'))

  it('git branch -d (delete) is unsafe', () => unsafe('git branch -d feature'))
  it('git branch new-branch (create) is unsafe', () => unsafe('git branch new-branch'))
  it('git checkout status — status is NOT the subcommand here, unsafe', () => unsafe('git checkout status'))
})

describe('classifyCommand — sed only safe for read patterns', () => {
  it("sed -n 1,5p f is safe", () => safe('sed -n 1,5p f'))
  it("sed -n '1,5p' f (quoted) is safe", () => safe("sed -n '1,5p' f"))
  it('sed -n 10p f is safe', () => safe('sed -n 10p f'))
  it('sed -i ... is unsafe', () => unsafe('sed -i s/a/b/ f'))
  it('sed s/a/b/ f (no -n) is unsafe', () => unsafe('sed s/a/b/ f'))
  it('sed -n xp f (non-numeric) is unsafe', () => unsafe('sed -n xp f'))
})

describe('classifyCommand — pipelines and operators', () => {
  it('safe | safe | safe is safe', () => safe('cat f | grep b | wc -l'))
  it('safe && safe is safe', () => safe('ls && pwd'))
  it('safe ; safe is safe', () => safe('echo hi ; ls'))
  it('safe || safe is safe', () => safe('grep foo f || true'))
  it('safe | UNSAFE is unsafe', () => unsafe('cat f | rm x'))
  it('UNSAFE | safe is unsafe', () => unsafe('rm x | cat'))
  it('safe && UNSAFE is unsafe', () => unsafe('ls && rm -rf /'))
  it('redirection > is unsafe', () => unsafe('ls > out.txt'))
  it('redirection >> is unsafe', () => unsafe('echo x >> out.txt'))
  it('redirection < is unsafe', () => unsafe('cat < in.txt'))
  it('background & is unsafe', () => unsafe('ls &'))
  it('command substitution $() is unsafe', () => unsafe('echo $(rm x)'))
  it('backtick substitution is unsafe', () => unsafe('echo `rm x`'))
  it('subshell ( ) is unsafe', () => unsafe('(ls)'))
  it('empty pipeline segment is unsafe', () => unsafe('ls |'))
})

describe('classifyCommand — operators inside quotes are literal data', () => {
  it("grep '&&' f is safe (operator is quoted)", () => safe("grep '&&' f"))
  it('grep "a|b" f is safe (pipe is quoted)', () => safe('grep "a|b" f'))
  it("echo '$(x)' is safe (substitution is quoted)", () => safe("echo '$(x)'"))
  it("echo '>' is safe (redirection char quoted)", () => safe("echo '>'"))
})
