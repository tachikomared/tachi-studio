// apps/desktop/src/components/WalletConfirmHost.tsx
//
// Renderer side of the wallet real-tx confirmation gate (audit S6). Mounted
// inside <ConfirmProvider>; when main asks to confirm a real send/transfer it
// shows the brutalist confirm modal and replies with the user's answer. A
// rejection (or closing the app) means the transaction is never broadcast.

import { useEffect } from 'react'
import { useConfirm } from './ConfirmProvider'

export function WalletConfirmHost() {
  const confirm = useConfirm()

  useEffect(() => {
    const unsub = window.tachi.wallet.onConfirmRequest(async ({ id, summary }) => {
      const what = summary.kind === 'token' ? 'transfer' : 'transaction'
      const approved = await confirm({
        title: 'CONFIRM TRANSACTION',
        message:
          `Send ${summary.amount} ${summary.symbol} to:\n${summary.to}\n\n` +
          `This signs and broadcasts a REAL on-chain ${what} from your wallet. ` +
          `It cannot be undone.`,
        okLabel: 'SIGN & SEND',
        cancelLabel: 'CANCEL',
        danger: true,
      })
      window.tachi.wallet.confirmRespond(id, approved)
    })
    return unsub
  }, [confirm])

  return null
}
