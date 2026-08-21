// packages/core/src/tachi/__tests__/salvage.test.ts
import { describe, it, expect } from 'vitest'
import { salvageToolCalls } from '../salvage.js'
import type { SalvagedCall } from '../contract.js'

describe('salvageToolCalls — empty / no-op cases', () => {
  it('returns [] for an empty string', () => {
    expect(salvageToolCalls('')).toEqual([])
  })

  it('returns [] for whitespace-only text', () => {
    expect(salvageToolCalls('   \n\t  ')).toEqual([])
  })

  it('returns [] for plain prose that merely mentions the word "function"', () => {
    const prose =
      'You can define a function in TypeScript and then call it. The read function ' +
      'takes a path argument. I will now write the function for you.'
    expect(salvageToolCalls(prose)).toEqual([])
  })

  it('returns [] for prose mentioning tool calls / arguments without any tool-shaped encoding', () => {
    const prose =
      'I would call the read tool with the arguments path and limit, but I need ' +
      'your confirmation first before invoking any tool_call.'
    expect(salvageToolCalls(prose)).toEqual([])
  })
})

describe("salvageToolCalls — 'xml-function' encoding", () => {
  it('parses <function=NAME>{...}</function>', () => {
    const text = '<function=read>{"path": "src/index.ts"}</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'src/index.ts' }, via: 'xml-function' },
    ])
  })

  it('parses <function=NAME> with quoted name attr variant', () => {
    const text = '<function="grep">{"pattern": "TODO", "glob": "*.ts"}</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'grep', args: { pattern: 'TODO', glob: '*.ts' }, via: 'xml-function' },
    ])
  })

  it('parses <function_call name="NAME">{...}</function_call>', () => {
    const text = '<function_call name="bash">{"command": "ls -la"}</function_call>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'bash', args: { command: 'ls -la' }, via: 'xml-function' },
    ])
  })

  it('parses an xml-function call surrounded by prose', () => {
    const text =
      'Sure, let me look at that file for you.\n' +
      '<function=read>{"path": "README.md"}</function>\n' +
      'That should show the contents.'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'README.md' }, via: 'xml-function' },
    ])
  })

  it('tolerates whitespace/newlines inside the function body', () => {
    const text = '<function=write>\n  {\n    "path": "a.txt",\n    "content": "hi"\n  }\n</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'write', args: { path: 'a.txt', content: 'hi' }, via: 'xml-function' },
    ])
  })

  it('handles nested JSON objects in the args', () => {
    const text = '<function=edit>{"path": "x.ts", "opts": {"flexible": true, "n": 3}}</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'edit', args: { path: 'x.ts', opts: { flexible: true, n: 3 } }, via: 'xml-function' },
    ])
  })
})

describe("salvageToolCalls — 'xml-tool_call' encoding", () => {
  it('parses <tool_call> with an arguments OBJECT', () => {
    const text = '<tool_call>{"name": "glob", "arguments": {"pattern": "**/*.md"}}</tool_call>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'glob', args: { pattern: '**/*.md' }, via: 'xml-tool_call' },
    ])
  })

  it('parses <tool_call> with arguments as a JSON STRING (double parse)', () => {
    // The inner arguments value is itself a JSON-encoded string.
    const text =
      '<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"deep.ts\\", \\"limit\\": 50}"}</tool_call>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'deep.ts', limit: 50 }, via: 'xml-tool_call' },
    ])
  })

  it('parses <tool_call> surrounded by prose', () => {
    const text =
      'Let me search.\n<tool_call>{"name": "grep", "arguments": {"pattern": "foo"}}</tool_call>\nDone.'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'grep', args: { pattern: 'foo' }, via: 'xml-tool_call' },
    ])
  })

  it('treats an empty arguments object as empty args', () => {
    const text = '<tool_call>{"name": "glob", "arguments": {}}</tool_call>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'glob', args: {}, via: 'xml-tool_call' },
    ])
  })
})

describe("salvageToolCalls — 'json-block' encoding", () => {
  it('parses a fenced ```json block with name/arguments', () => {
    const text = [
      'Here is the call:',
      '```json',
      '{"name": "read", "arguments": {"path": "main.ts"}}',
      '```',
    ].join('\n')
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'main.ts' }, via: 'json-block' },
    ])
  })

  it('parses a fenced ```json block with tool/args aliases', () => {
    const text = ['```json', '{"tool": "bash", "args": {"command": "pwd"}}', '```'].join('\n')
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'bash', args: { command: 'pwd' }, via: 'json-block' },
    ])
  })

  it('parses a json-block whose args is a JSON string (double parse)', () => {
    const text = ['```json', '{"name": "edit", "arguments": "{\\"path\\": \\"z.ts\\"}"}', '```'].join('\n')
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'edit', args: { path: 'z.ts' }, via: 'json-block' },
    ])
  })

  it('returns [] for a ```json fence that is just data (no name/arguments/tool keys)', () => {
    const text = [
      'Here is some example data:',
      '```json',
      '{"path": "main.ts", "limit": 100, "items": [1, 2, 3]}',
      '```',
    ].join('\n')
    expect(salvageToolCalls(text)).toEqual([])
  })

  it('returns [] for a ```json fence holding a bare array (not a call object)', () => {
    const text = ['```json', '[{"name": "x"}, {"name": "y"}]', '```'].join('\n')
    expect(salvageToolCalls(text)).toEqual([])
  })
})

describe("salvageToolCalls — 'bare-json' encoding", () => {
  it('parses when the WHOLE trimmed text is a {name, arguments} object', () => {
    const text = '  {"name": "read", "arguments": {"path": "only.ts"}}  '
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'only.ts' }, via: 'bare-json' },
    ])
  })

  it('parses bare-json with tool/args aliases', () => {
    const text = '{"tool": "glob", "args": {"pattern": "*.json"}}'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'glob', args: { pattern: '*.json' }, via: 'bare-json' },
    ])
  })

  it('parses bare-json whose arguments is a JSON string (double parse)', () => {
    const text = '{"name": "bash", "arguments": "{\\"command\\": \\"echo hi\\"}"}'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'bash', args: { command: 'echo hi' }, via: 'bare-json' },
    ])
  })

  it('parses a clearly-delimited single line that is the call object', () => {
    const text =
      'I will run this now:\n{"name": "bash", "arguments": {"command": "make build"}}\nStand by.'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'bash', args: { command: 'make build' }, via: 'bare-json' },
    ])
  })

  it('does NOT treat prose with an inline brace-y mention as a bare-json call', () => {
    const text =
      'If you pass {"name": "read"} it would read a file, but you also need arguments.'
    expect(salvageToolCalls(text)).toEqual([])
  })

  it('returns [] for a bare object that lacks name/tool keys even if whole text', () => {
    const text = '{"path": "main.ts", "limit": 10}'
    expect(salvageToolCalls(text)).toEqual([])
  })

  it('returns [] for a bare JSON array as the whole text', () => {
    const text = '[1, 2, 3]'
    expect(salvageToolCalls(text)).toEqual([])
  })
})

describe('salvageToolCalls — args normalisation & malformed handling', () => {
  it('returns an empty args object when arguments key is absent', () => {
    const text = '<function=glob>{}</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'glob', args: {}, via: 'xml-function' },
    ])
  })

  it('SKIPS a call whose JSON args are malformed (does not throw)', () => {
    const text = '<function=read>{path: not valid json,,}</function>'
    expect(salvageToolCalls(text)).toEqual([])
  })

  it('SKIPS a tool_call whose arguments-string is itself malformed', () => {
    const text = '<tool_call>{"name": "read", "arguments": "{not json}"}</tool_call>'
    expect(salvageToolCalls(text)).toEqual([])
  })

  it('SKIPS one malformed call but keeps a sibling valid one (document order)', () => {
    const text =
      '<function=read>{bad json}</function>\n' +
      '<function=grep>{"pattern": "ok"}</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'grep', args: { pattern: 'ok' }, via: 'xml-function' },
    ])
  })

  it('SKIPS a call whose parsed args are a JSON array (args must be an object)', () => {
    const text = '<function=read>[1, 2, 3]</function>'
    expect(salvageToolCalls(text)).toEqual([])
  })

  it('SKIPS a call whose parsed args are a JSON scalar (args must be an object)', () => {
    const text = '<function=read>42</function>'
    expect(salvageToolCalls(text)).toEqual([])
  })
})

describe('salvageToolCalls — multiple calls in document order', () => {
  it('returns multiple xml-function calls in order', () => {
    const text =
      '<function=read>{"path": "a.ts"}</function>\n' +
      'then\n' +
      '<function=edit>{"path": "a.ts", "old": "x"}</function>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'a.ts' }, via: 'xml-function' },
      { name: 'edit', args: { path: 'a.ts', old: 'x' }, via: 'xml-function' },
    ])
  })

  it('returns multiple <tool_call> calls in order', () => {
    const text =
      '<tool_call>{"name": "grep", "arguments": {"pattern": "a"}}</tool_call>' +
      '<tool_call>{"name": "grep", "arguments": {"pattern": "b"}}</tool_call>'
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'grep', args: { pattern: 'a' }, via: 'xml-tool_call' },
      { name: 'grep', args: { pattern: 'b' }, via: 'xml-tool_call' },
    ])
  })

  it('returns calls from MIXED encodings in document order', () => {
    const text = [
      'First a function tag:',
      '<function=read>{"path": "one.ts"}</function>',
      'Now a tool_call:',
      '<tool_call>{"name": "grep", "arguments": {"pattern": "two"}}</tool_call>',
      'And a json block:',
      '```json',
      '{"name": "bash", "arguments": {"command": "three"}}',
      '```',
    ].join('\n')
    expect(salvageToolCalls(text)).toEqual<SalvagedCall[]>([
      { name: 'read', args: { path: 'one.ts' }, via: 'xml-function' },
      { name: 'grep', args: { pattern: 'two' }, via: 'xml-tool_call' },
      { name: 'bash', args: { command: 'three' }, via: 'json-block' },
    ])
  })
})
