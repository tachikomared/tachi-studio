// apps/desktop/electron/services/nook-messaging-service.ts
//
// Messaging domain module for the nookplot integration — direct messages (the
// gateway "inbox", PostgreSQL-backed agent-to-agent DMs) and group channels.
//
// This builds on the single connected runtime owned by nook-service.ts via
// getRuntime(); it never opens its own connection. Every method guards on a
// live runtime and throws 'Connect first' otherwise so the renderer can show a
// clean error rather than a null deref.
//
// Shapes here are mapped defensively from @nookplot/runtime's types.d.ts:
//   - inbox.getMessages() -> { messages: InboxMessage[], limit, offset }
//       InboxMessage = { id, from, fromName?, to, messageType, content,
//                        metadata, readAt, createdAt }
//   - inbox.send({ to, content, messageType?, metadata? }) -> { id, createdAt }
//   - channels.list() -> { channels: Channel[], limit, offset }
//       Channel = { id, slug, name, description, channelType, isPublic,
//                   memberCount?, isMember?, createdAt, ... }
//   - channels.getHistory(id) -> { messages: ChannelMessage[], limit }
//       ChannelMessage = { id, from, fromName, messageType, content,
//                          metadata, signature, createdAt }
//   - channels.send(id, content) -> { id, createdAt }
//   - channels.getMembers(id) -> { members: ChannelMember[] }
//
// Auth'd reads can't be smoke-tested without a real session, so we read every
// field through optional chaining + String()/Number() coercion and keep a `raw`
// escape hatch on each view.

import { getRuntime } from './nook-service'

function rt() {
  const r = getRuntime()
  if (!r) throw new Error('Connect first')
  return r
}

// ── Renderer-facing views ─────────────────────────────────────────────────────

export interface NookDMView {
  id: string
  from: string
  fromName: string | null
  to: string
  content: string
  messageType: string
  unread: boolean
  createdAt: string
  raw: Record<string, unknown>
}

export interface NookChannelView {
  id: string
  slug: string
  name: string
  description: string | null
  channelType: string
  isPublic: boolean
  memberCount: number | null
  isMember: boolean
  createdAt: string
  raw: Record<string, unknown>
}

export interface NookChannelMessageView {
  id: string
  from: string
  fromName: string | null
  content: string
  messageType: string
  createdAt: string
  raw: Record<string, unknown>
}

export interface NookChannelMemberView {
  address: string
  displayName: string | null
  role: string | null
  raw: Record<string, unknown>
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function viewDM(m: Record<string, unknown>): NookDMView {
  return {
    id: String(m.id ?? ''),
    from: String(m.from ?? ''),
    fromName: (m.fromName as string) ?? null,
    to: String(m.to ?? ''),
    content: String(m.content ?? ''),
    messageType: String(m.messageType ?? 'text'),
    unread: m.readAt == null,
    createdAt: String(m.createdAt ?? ''),
    raw: m,
  }
}

function viewChannel(c: Record<string, unknown>): NookChannelView {
  return {
    id: String(c.id ?? ''),
    slug: String(c.slug ?? ''),
    name: String(c.name ?? c.slug ?? '(channel)'),
    description: (c.description as string) ?? null,
    channelType: String(c.channelType ?? ''),
    isPublic: Boolean(c.isPublic),
    memberCount: c.memberCount != null ? Number(c.memberCount) : null,
    isMember: Boolean(c.isMember),
    createdAt: String(c.createdAt ?? ''),
    raw: c,
  }
}

function viewChannelMessage(m: Record<string, unknown>): NookChannelMessageView {
  return {
    id: String(m.id ?? ''),
    from: String(m.from ?? ''),
    fromName: (m.fromName as string) ?? null,
    content: String(m.content ?? ''),
    messageType: String(m.messageType ?? 'text'),
    createdAt: String(m.createdAt ?? ''),
    raw: m,
  }
}

function viewMember(m: Record<string, unknown>): NookChannelMemberView {
  return {
    address: String(m.agentAddress ?? m.address ?? ''),
    displayName: (m.displayName as string) ?? null,
    role: (m.role as string) ?? null,
    raw: m,
  }
}

// ── Inbox (direct messages) ────────────────────────────────────────────────────

/** List inbox DMs (newest-first as returned by the gateway). */
export async function inboxList(opts?: { unreadOnly?: boolean; from?: string; limit?: number }): Promise<NookDMView[]> {
  let res: unknown
  try {
    res = await rt().inbox.getMessages({
      unreadOnly: opts?.unreadOnly,
      from: opts?.from,
      limit: opts?.limit ?? 50,
    })
  } catch (e) {
    // The gateway returns 500 "Failed to list messages" for an EMPTY inbox
    // (common right after registration). It can also 500 on the query-param
    // form, so retry the BARE endpoint once before concluding the inbox is
    // empty — that way we still recover real messages if it was the params.
    // Treat a persistent 500 as an empty inbox (clean empty state, no console
    // noise). Any other failure (auth/network) is re-thrown to surface.
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
    if (msg.includes('failed to list messages') || msg.includes('(500)')) {
      try { res = await rt().inbox.getMessages({}) } catch { return [] }
    } else {
      throw e
    }
  }
  const rows = (res as { messages?: unknown[] }).messages ?? []
  return (rows as Record<string, unknown>[]).map(viewDM)
}

/** Unread DM count (for a badge). */
export async function unreadCount(): Promise<number> {
  try {
    const res = await rt().inbox.getUnreadCount()
    return Number((res as { unreadCount?: number }).unreadCount ?? 0)
  } catch { return 0 }
}

/** Send a direct message to another agent's address. */
export async function sendDM(toAddress: string, content: string): Promise<{ id: string; createdAt: string }> {
  const to = toAddress.trim()
  const body = content.trim()
  if (!to) throw new Error('Recipient address is required.')
  if (!body) throw new Error('Message is empty.')
  const res = await rt().inbox.send({ to, content: body })
  return { id: String(res.id ?? ''), createdAt: String(res.createdAt ?? '') }
}

/** Mark a DM read. */
export async function markRead(messageId: string): Promise<{ ok: true }> {
  await rt().inbox.markRead(messageId)
  return { ok: true }
}

// ── Channels (group messaging) ───────────────────────────────────────────────

/** List channels. */
export async function listChannels(opts?: { limit?: number; isPublic?: boolean; channelType?: string }): Promise<NookChannelView[]> {
  const res = await rt().channels.list({
    limit: opts?.limit ?? 50,
    isPublic: opts?.isPublic,
    channelType: opts?.channelType,
  })
  const rows = (res as { channels?: unknown[] }).channels ?? []
  return (rows as Record<string, unknown>[]).map(viewChannel)
}

/** Message history for a channel (newest-last as the gateway returns it). */
export async function channelMessages(channelId: string, opts?: { limit?: number; before?: string }): Promise<NookChannelMessageView[]> {
  const res = await rt().channels.getHistory(channelId, { limit: opts?.limit ?? 50, before: opts?.before })
  const rows = (res as { messages?: unknown[] }).messages ?? []
  return (rows as Record<string, unknown>[]).map(viewChannelMessage)
}

/** Members of a channel. */
export async function channelMembers(channelId: string): Promise<NookChannelMemberView[]> {
  const res = await rt().channels.getMembers(channelId)
  const rows = (res as { members?: unknown[] }).members ?? []
  return (rows as Record<string, unknown>[]).map(viewMember)
}

/** Send a message to a channel. */
export async function sendChannel(channelId: string, content: string): Promise<{ id: string; createdAt: string }> {
  const body = content.trim()
  if (!body) throw new Error('Message is empty.')
  const res = await rt().channels.send(channelId, body)
  return { id: String(res.id ?? ''), createdAt: String(res.createdAt ?? '') }
}

/** Join a channel (needed before sending if not already a member). */
export async function joinChannel(channelId: string): Promise<{ ok: true }> {
  await rt().channels.join(channelId)
  return { ok: true }
}

/** Leave a channel. */
export async function leaveChannel(channelId: string): Promise<{ ok: true }> {
  await rt().channels.leave(channelId)
  return { ok: true }
}
