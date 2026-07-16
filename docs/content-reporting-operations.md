# Content-reporting operator runbook

This runbook is for the private Momora operator/service-role environment. Never expose the queue, notes, protected account attribution, or resolution metadata to another household member.

## Review cadence and priority

- Review open/reviewing reports at least daily during release operation.
- Immediately prioritize suspected child sexual content, credible threats, exploitation, or imminent safety concerns. Follow applicable legal/escalation obligations; do not copy sensitive child content into tickets or chat.
- Next prioritize harassment/abuse and privacy reports, then misleading AI depictions and other reports.
- Momora does not promise a public fixed response time.

## Minimal review procedure

1. Query only `open`/`reviewing` rows ordered by priority and `created_at`.
2. Mark the selected row `reviewing` before investigation.
3. Start from identifiers, reason, and the optional reporter note. Inspect the live target only when necessary to decide the report.
4. Never export memory text, child names, report notes, signed URLs, R2 keys, or image bytes into logs, analytics, issue trackers, or support messages.
5. If a generated image has been regenerated/deleted, its bytes may no longer exist. Treat that as content removal; do not restore or archive child imagery solely for moderation.
6. Choose the minimum action: dismiss, remove the target, restrict/suspend the attributed account through the approved admin process, or record another action.
7. Resolve the row with `resolution`, `resolved_at`, and the operator's `resolved_by` id. Do not rewrite the reporter's reason or note.

## Resolution values

| Value | Use when |
|---|---|
| `dismissed` | The live target does not violate policy or cannot support the allegation. |
| `content_removed` | Content was deleted, regenerated, or already unavailable. |
| `account_suspended` | The approved admin process restricted the responsible account. |
| `other_action` | A documented action does not fit the values above. |

## Audit, privacy, and retention

- `content_reports` intentionally contains no content snapshot. `target_user_id` is protected operator context and can become null on auth-account deletion.
- Reporter deletion clears the optional note and anonymizes the reporter id. Do not attempt to re-identify an anonymized reporter.
- Family deletion cascades its queue records. Account hard deletion and the existing 15-day deletion lifecycle remain authoritative.
- Access the table only through a secured service-role/operator path. Authenticated clients have no direct access.
- Operational logs may contain generic report id, target type, status, and error code. They must not contain note text, names, journal content, image URLs/keys, or raw invite codes.

## Release operations checklist

- [ ] Assign the person responsible for the daily queue check.
- [ ] Verify only approved operators/service roles can query or update `content_reports`.
- [ ] Verify the client RPC returns no `note`, `target_user_id`, resolution, or operator fields.
- [ ] Exercise one report through review and resolution in the production-like environment.
- [ ] Confirm urgent safety escalation contact/process is available.
- [ ] Review queue access after personnel or credential changes.
