# Feature: Voice journaling

**Status:** `done`
**Last updated:** 2026-05-25
**PRD reference:** §6.5 Voice input

## Overview

Tap-to-record voice memos (max 2 minutes). Audio is transcribed server-side, cleaned, and name-tagged before the user edits and saves as a normal memory.

## User-facing behavior

- **New memory** → **Tap to record voice memory** → stop → transcript populates content + suggested tags.
- User can edit text and tags before save.
- Recording auto-stops at 2 minutes.

## Architecture

```mermaid
flowchart LR
  Mic[expo-audio recorder] --> B64[base64 in memory]
  B64 --> Edge[process-voice-memory]
  Edge --> OpenAI[Transcribe + cleanup]
  OpenAI --> Form[New memory form]
```

## API

| Function | Input | Output |
|----------|-------|--------|
| `process-voice-memory` | `audioBase64`, `familyMembers[]` | `cleanedText`, `mentionedMemberIds` |

Auth: JWT. Audio is discarded after processing.

## Client integration

| Layer | Files |
|-------|-------|
| Hook | `src/hooks/useVoiceInput.ts` |
| Service | `src/services/ai.ts` (`processVoiceMemory`) |
| UI | `app/(app)/new-memory.tsx` |

## Family sharing

`process-voice-memory` itself is stateless and unchanged, but the client
now passes the **active family's** members (not a single user's) as
`familyMembers` for name-aware transcription and tag suggestion. Memory
creation from the resulting text still goes through the family-scoped
`memories` insert path — see [family-sharing.md](./family-sharing.md).

## Constraints

- **`expo-audio` only** (not `expo-av`).
- Requires dev client rebuild after adding native module.
- Microphone permission required.

## Testing

| Layer | File |
|-------|------|
| Deno | `supabase/functions/process-voice-memory/index.test.ts` |
| E2E | Covered via new-memory flow (text path; voice optional in CI) |
