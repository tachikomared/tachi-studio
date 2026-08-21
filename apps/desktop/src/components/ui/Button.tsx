// Button — the brutalist button primitive.
//
// Centralizes the 2px-border / hard-shadow / JetBrains-Mono / uppercase button
// face that was hand-rolled inline across dozens of files, plus consistent
// disabled and hover states. The global button press-feel (translate on
// :active, shadow collapse) comes from globals.css and applies automatically.
//
//   <Button variant="primary" onClick={save}>Save</Button>
//   <Button variant="ghost">Cancel</Button>
//   <Button variant="danger" disabled={busy}>Delete</Button>
import React from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const SIZE: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '3px 10px', fontSize: 10 },
  md: { padding: '5px 14px', fontSize: 11 },
}

function variantStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case 'primary':
      return { border: '2px solid var(--accent)', background: 'var(--accent)', color: '#fff' }
    case 'danger':
      return { border: '2px solid var(--danger)', background: 'transparent', color: 'var(--danger)' }
    case 'ghost':
    default:
      return { border: '2px solid var(--border)', background: 'transparent', color: 'var(--text-primary)' }
  }
}

export function Button({
  variant = 'ghost',
  size = 'md',
  disabled,
  style,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...SIZE[size],
        ...variantStyle(variant),
        fontFamily: 'JetBrains Mono, monospace',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderRadius: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

export default Button
