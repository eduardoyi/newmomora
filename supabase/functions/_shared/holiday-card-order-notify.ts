/**
 * Owner alerts and buyer emails for holiday-card orders (docs/plans/
 * holiday-cards-p1.md Step 6). Same channel and style as the Memory Book
 * orders (`stripe-webhook` / `sweep-memory-book-orders`): Bento transactional
 * email to the owner alert address, PII-free by construction (order id and a
 * closed reason code only; never an address, a letter or a Stripe object).
 * No new channels.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { sendTransactionalEmailWithOutcome } from './bento.ts';

export type SendEmail = typeof sendTransactionalEmailWithOutcome;

const DEFAULT_ALERT_RECIPIENT = 'hello@usemomora.com';

function getAlertRecipient(): string {
  return Deno.env.get('MEMORY_BOOK_ORDER_ALERT_EMAIL')?.trim() || DEFAULT_ALERT_RECIPIENT;
}

const SAFE_TEXT = /[^A-Za-z0-9 _.:,;()'/-]/g;

/** Keeps free text out of the email body: letters, digits and basic punctuation only. */
function plain(value: string, max = 300): string {
  return value.replace(SAFE_TEXT, '').slice(0, max);
}

/**
 * Best-effort owner alarm for a card order (or a card). A failed send is logged,
 * never thrown: the caller's own state change has already happened and a retry
 * of the whole request would not fix an email problem.
 */
export async function alertCardOwner(
  sendEmail: SendEmail,
  subjectId: string,
  reason: string,
  detail: string,
): Promise<void> {
  try {
    const outcome = await sendEmail({
      to: getAlertRecipient(),
      subject: `Momora card order alert: ${plain(reason, 80)}`,
      htmlBody: `<p>Holiday card order/card <code>${plain(subjectId, 80)}</code> needs attention.</p><p>Reason: ${plain(reason, 80)}</p><p>${plain(detail)}</p>`,
    });
    if (outcome !== 'sent') console.error('holiday-card owner alert not confirmed sent', plain(reason, 80));
  } catch (error) {
    console.error('holiday-card owner alert failed', plain(reason, 80), error instanceof Error ? error.name : 'unknown');
  }
}

/** The buyer's account email, or null. Never throws. */
export async function lookupBuyerEmail(supabase: SupabaseClient, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await supabase.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "Your cards are on their way to print" (sent once, by whoever wins the paid -> submitted CAS). */
export async function sendCardOrderConfirmationEmail(
  sendEmail: SendEmail,
  supabase: SupabaseClient,
  order: { requested_by: string | null; packs: number | null },
): Promise<void> {
  const email = await lookupBuyerEmail(supabase, order.requested_by);
  if (!email) return;
  const cards = order.packs ? order.packs * 10 : null;
  try {
    await sendEmail({
      to: email,
      subject: 'Your Momora holiday cards are on their way to print',
      htmlBody: `<p>Thank you! Your order${cards ? ` of ${cards} holiday cards` : ''} was received and sent to our printer.</p><p>We will email you again with tracking details as soon as it ships.</p>`,
    });
  } catch (error) {
    console.error('holiday-card confirmation email failed', error instanceof Error ? error.name : 'unknown');
  }
}

/** "Your cards have shipped", with the tracking link or number when we have one. */
export async function sendCardShippedEmail(
  sendEmail: SendEmail,
  supabase: SupabaseClient,
  order: { requested_by: string | null },
  tracking: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null },
): Promise<void> {
  const email = await lookupBuyerEmail(supabase, order.requested_by);
  if (!email) return;
  const carrierSuffix = tracking.carrier ? ` via ${escapeHtml(tracking.carrier)}` : '';
  const safeUrl = tracking.trackingUrl && /^https:\/\//i.test(tracking.trackingUrl) ? escapeHtml(tracking.trackingUrl) : null;
  const trackingHtml = safeUrl
    ? `<p>Track your delivery${carrierSuffix}: <a href="${safeUrl}">${safeUrl}</a></p>`
    : tracking.trackingNumber
      ? `<p>Tracking number${carrierSuffix}: ${escapeHtml(tracking.trackingNumber)}</p>`
      : '';
  try {
    await sendEmail({
      to: email,
      subject: 'Your Momora holiday cards have shipped',
      htmlBody: `<p>Great news -- your holiday cards have shipped!</p>${trackingHtml}`,
    });
  } catch (error) {
    console.error('holiday-card shipped email failed', error instanceof Error ? error.name : 'unknown');
  }
}
