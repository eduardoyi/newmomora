import { useEffect } from 'react';
import { handoffController } from '../auth/handoffRuntime';
import { signOut, useAuthSession } from '../auth/useAuthSession';
import { useHandoff } from '../auth/useHandoff';
import { accountNote } from './accountNote';
import { registerHeader } from './headerPresence';
import { ShopHeader } from './ShopHeader';

export interface ConnectedShopHeaderProps {
  onHome: () => void;
  /** Omit to hide "Your orders". */
  onOpenOrders?: () => void;
  showBack?: boolean;
}

/**
 * `ShopHeader` wired to the session: "Sign out" (this browser only), and the
 * handoff's account line. While mounted it tells `HandoffChipHost` not to draw
 * the floating chip (which would cover a page's sticky bottom bar on phones).
 */
export function ConnectedShopHeader({ onHome, onOpenOrders, showBack }: ConnectedShopHeaderProps) {
  const { session } = useAuthSession();
  const handoff = useHandoff();
  useEffect(() => registerHeader(), []);

  const note = accountNote(handoff, session ? { userId: session.user.id, email: session.user.email ?? null } : null);
  const account = note
    ? {
        message: note.message,
        actionLabel: note.actionLabel,
        onAction: () => {
          if (note.kind === 'signedIn') void signOut().then(() => handoffController.reset());
          else handoffController.reset();
        },
      }
    : null;

  return <ShopHeader onHome={onHome} onOrders={onOpenOrders} onSignOut={() => void signOut()} showBack={showBack} account={account} />;
}
