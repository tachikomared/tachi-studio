// apps/desktop/src/pages/aeon/ChannelsCard.tsx
//
// Notification channels for Aeon's autonomous skill runs. Aeon natively
// supports Telegram, Discord, Slack, and Email — activated by pushing the
// right GitHub Actions secret to the user's fork. No workflow patching
// required (the workflow already conditionally fires `curl` to each channel
// when its env vars are present — verified against aaronjmars/aeon@main).
//
// Pattern mirrors ProviderCard: each row collects the channel's secrets and
// pushes via `aeon:set-secret`. Multiple-secret channels (Telegram needs
// BOT_TOKEN + CHAT_ID) push sequentially.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showToast } from '../../components/Toaster'

const cardStyle: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-hard)',
}

const headerStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  fontFamily: 'JetBrains Mono, monospace',
}

const rowStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: 'var(--border-width) solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: 'var(--border-width) solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  outline: 'none',
  boxSizing: 'border-box',
}

const pushBtnStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: 'var(--border-width) solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: '0.04em',
  alignSelf: 'flex-start',
}

interface SecretField {
  /** GitHub Actions secret name (UPPER_SNAKE). */
  name:         string
  /** Short label shown above the input. */
  label:        string
  placeholder:  string
  /** Plain-text input vs masked password input. Tokens use password; chat IDs use plain. */
  reveal?:      boolean
}

interface ChannelConfig {
  id:           'telegram' | 'discord-webhook' | 'discord-bot' | 'slack-webhook' | 'slack-bot' | 'email'
  label:        string
  description:  string
  /** External docs/setup link surfaced as "How to get this" affordance. */
  helpUrl:      string
  helpLabel:    string
  /** All secrets pushed in one click; if any is empty, the push is blocked. */
  fields:       SecretField[]
}

const CHANNELS: ChannelConfig[] = [
  {
    id:        'telegram',
    label:     'Telegram',
    description: 'Most popular channel — Aeon sends skill outputs as messages and you can reply with commands. Create a bot with @BotFather, then send /start to your bot from your account.',
    helpUrl:   'https://core.telegram.org/bots/tutorial',
    helpLabel: 'BotFather tutorial',
    fields: [
      { name: 'TELEGRAM_BOT_TOKEN', label: 'Bot token',  placeholder: '7123456789:AAH…',          reveal: false },
      { name: 'TELEGRAM_CHAT_ID',   label: 'Chat ID',    placeholder: '123456789 (your user ID)', reveal: true  },
    ],
  },
  {
    id:        'discord-webhook',
    label:     'Discord (outbound only)',
    description: 'Easiest Discord setup — push-only. Channel → Edit Channel → Integrations → Webhooks → Create. No bot permissions needed.',
    helpUrl:   'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
    helpLabel: 'Webhook setup',
    fields: [
      { name: 'DISCORD_WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
    ],
  },
  {
    id:        'discord-bot',
    label:     'Discord (inbound + outbound)',
    description: 'Full two-way Discord. discord.com/developers → New Application → Bot → enable Message Content intent, copy bot token. Invite bot to your server with channels:history scope.',
    helpUrl:   'https://discord.com/developers/applications',
    helpLabel: 'Discord Developer Portal',
    fields: [
      { name: 'DISCORD_BOT_TOKEN',  label: 'Bot token',  placeholder: 'MTIzNDU2…',     reveal: false },
      { name: 'DISCORD_CHANNEL_ID', label: 'Channel ID', placeholder: '123456789…',    reveal: true  },
    ],
  },
  {
    id:        'slack-webhook',
    label:     'Slack (outbound only)',
    description: 'Push-only Slack. api.slack.com → Your Apps → Create New App → From scratch → Incoming Webhooks → Add to channel → copy URL.',
    helpUrl:   'https://api.slack.com/messaging/webhooks',
    helpLabel: 'Slack webhook docs',
    fields: [
      { name: 'SLACK_WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…' },
    ],
  },
  {
    id:        'slack-bot',
    label:     'Slack (inbound + outbound)',
    description: 'Full two-way Slack. App → OAuth & Permissions → add channels:history + reactions:write scopes → install → copy Bot User OAuth Token. Channel ID is in the URL.',
    helpUrl:   'https://api.slack.com/authentication/token-types#bot',
    helpLabel: 'Bot token docs',
    fields: [
      { name: 'SLACK_BOT_TOKEN',  label: 'Bot token',  placeholder: 'xoxb-…',        reveal: false },
      { name: 'SLACK_CHANNEL_ID', label: 'Channel ID', placeholder: 'C01234ABCDE',   reveal: true  },
    ],
  },
  {
    id:        'email',
    label:     'Email (SendGrid)',
    description: 'Skill outputs arrive as styled HTML emails. sendgrid.com/settings/api_keys → Create API Key with Mail Send permission → copy. Set the recipient address you want notifications sent to.',
    helpUrl:   'https://sendgrid.com/settings/api_keys',
    helpLabel: 'SendGrid API keys',
    fields: [
      { name: 'SENDGRID_API_KEY', label: 'SendGrid API key', placeholder: 'SG.…',                    reveal: false },
      { name: 'NOTIFY_EMAIL_TO',  label: 'Recipient email',  placeholder: 'you@example.com',         reveal: true  },
    ],
  },
]

interface ChannelsCardProps {
  owner: string
}

export function ChannelsCard({ owner }: ChannelsCardProps) {
  const { t } = useTranslation('aeon')
  // Track per-channel push state. A successful push is sticky for the session
  // so the badge stays visible even after the inputs clear.
  const [pushed, setPushed] = useState<Record<string, boolean>>({})
  const [pushing, setPushing] = useState<string | null>(null)

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>{t('channels.header')}</div>

      <div style={{
        padding: '8px 12px',
        fontSize: 10,
        color: 'var(--text-dim)',
        borderBottom: 'var(--border-width) solid var(--border)',
        lineHeight: 1.5,
      }}>
        {t('channels.intro')}
      </div>

      {CHANNELS.map(channel => (
        <ChannelRow
          key={channel.id}
          channel={channel}
          owner={owner}
          alreadyPushed={!!pushed[channel.id]}
          pushing={pushing === channel.id}
          onPushStart={() => setPushing(channel.id)}
          onPushEnd={(ok) => {
            setPushing(null)
            if (ok) setPushed(s => ({ ...s, [channel.id]: true }))
          }}
        />
      ))}
    </div>
  )
}

interface ChannelRowProps {
  channel:       ChannelConfig
  owner:         string
  alreadyPushed: boolean
  pushing:       boolean
  onPushStart:   () => void
  onPushEnd:     (ok: boolean) => void
}

function ChannelRow({ channel, owner, alreadyPushed, pushing, onPushStart, onPushEnd }: ChannelRowProps) {
  const { t } = useTranslation('aeon')
  const [values, setValues] = useState<Record<string, string>>({})
  const allFilled = channel.fields.every(f => (values[f.name] ?? '').trim().length > 0)
  const channelLabel = t(`channels.items.${channel.id}.label`)

  async function handlePush() {
    onPushStart()
    try {
      // Sequential pushes — `aeon:set-secret` IPC is one-secret-per-call.
      // We do them in order so any single failure surfaces clearly without
      // leaving the channel half-configured.
      for (const field of channel.fields) {
        const value = (values[field.name] ?? '').trim()
        if (!value) throw new Error(`${field.label} is empty`)
        await window.tachi.aeon.setSecret(owner, field.name, value)
      }
      showToast({
        kind: 'success',
        text: t('channels.toast.pushed', { channel: channelLabel }),
      })
      // Clear inputs after successful push so leftover values don't get
      // accidentally re-pushed if the user clicks Push again.
      setValues({})
      onPushEnd(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast({ kind: 'error', text: t('channels.toast.pushFailed', { error: msg }) })
      onPushEnd(false)
    }
  }

  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={labelStyle}>{channelLabel}</span>
        {alreadyPushed && (
          <span style={{
            fontSize: 9,
            color: 'var(--success)',
            fontFamily: 'JetBrains Mono, monospace',
            border: 'var(--border-width) solid var(--success)',
            padding: '1px 5px',
            letterSpacing: '0.06em',
          }}>
            {t('channels.pushedBadge')}
          </span>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4 }}>
        {t(`channels.items.${channel.id}.description`)}
      </p>

      <button
        type="button"
        onClick={() => window.tachi.shell.openExternal(channel.helpUrl)}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'var(--accent)',
          textDecoration: 'underline',
          cursor: 'pointer',
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {t(`channels.items.${channel.id}.helpLabel`)} ↗
      </button>

      <div style={{
        fontSize: 9,
        color: 'var(--text-dim)',
        letterSpacing: '0.04em',
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        GH secrets → {channel.fields.map(f => (
          <code key={f.name} style={{ fontFamily: 'inherit', color: 'var(--text-primary)', marginRight: 4 }}>
            {f.name}
          </code>
        ))}
      </div>

      {channel.fields.map(field => (
        <div key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            letterSpacing: '0.06em',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            {t(`channels.secretLabels.${field.name}`)}
          </span>
          <input
            // `reveal: true` for chat IDs / emails / webhook URLs we want visible;
            // password for actual secrets so over-the-shoulder snooping is harder.
            type={field.reveal ? 'text' : 'password'}
            placeholder={field.placeholder}
            value={values[field.name] ?? ''}
            onChange={e => setValues(s => ({ ...s, [field.name]: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && allFilled && !pushing) handlePush() }}
            style={inputStyle}
          />
        </div>
      ))}

      <button
        onClick={handlePush}
        disabled={!allFilled || pushing}
        style={{ ...pushBtnStyle, opacity: !allFilled || pushing ? 0.5 : 1, cursor: !allFilled || pushing ? 'default' : 'pointer' }}
      >
        {pushing
          ? t('channels.pushing')
          : channel.fields.length > 1
            ? t('channels.pushMany', { count: channel.fields.length })
            : t('channels.pushOne')}
      </button>
    </div>
  )
}
