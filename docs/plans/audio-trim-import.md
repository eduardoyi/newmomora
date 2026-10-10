# Audio memories v2: trim, import, real waveforms

**Status:** implemented (2026-10-10), pending: device QA, migration + edge deploy, backfill run, store build 1.5.0; P1b (iOS Ogg) awaiting owner decision. (Earlier: planned 2026-10-10, hardened through 3 adversarial review rounds — Sonnet completeness, Sonnet failure modes, Opus holistic; spike done, see "Spike results".)
**Feature doc:** [docs/features/audio-memories.md](../features/audio-memories.md) (v1, shipped 2026-08-20).

## Goal

Three additions to "keep the sound" audio memories:

1. **Trim before save.** After "Keep the sound" (or after importing), the parent can trim the start and end of the clip in the composer. Trimming is optional and destructive: only the trimmed audio is **stored** (R2, export, year film). Note: the full clip is still sent for transcription the moment recording stops (v1's zero-wait fork), so "trim" is a keepsake edit, not a privacy guarantee about what reached OpenAI; the feature doc must say so.
2. **Import outside audio.** A parent can bring in an existing voice note (WhatsApp, Voice Memos, Files) as an audio memory: via the iOS/Android share sheet ("Share → Momora") and via an in-app "A sound or voice note" option in the composer's attach menu, with a short in-app guide to finding WhatsApp's hidden share button.
3. **Real waveforms everywhere.** Every audio surface draws the clip's real loudness contour instead of the seeded decorative line, including existing audio memories (backfilled).

Done = all three shipped in one store build (native module + share/picker config), with JS that degrades cleanly on older store binaries that receive OTAs.

## Decisions already made (owner, 2026-10-10)

- Trim is **pre-save only** (composer). Post-save trim (edit screen) is V2. The edit screen keeps "Kept as recorded."
- Trim is **destructive, on-device, before upload** (not stored trim points). Export, year film, playback, transcription all just see a shorter clip.
- **Real waveform everywhere** (card, detail, composer chip, fork modal, calendar stamp, member thumb, pending-upload card) **plus a backfill** of existing audio memories.
- **WhatsApp on iOS is a must-have.** (Real-file finding below: WhatsApp's iOS share produces AAC `.m4a`, not Ogg.)
- **Import length:** imports may be up to **5 minutes**; a longer source opens the trimmer, which won't continue until the selection is ≤ 5:00. In-app recording cap stays **2 minutes** (unchanged). Source files over **30 minutes** are refused outright.
- **In-app Files picker: yes** (owner couldn't find WhatsApp's share path unaided — the picker plus a guide is the discoverable route).
- WhatsApp date: the filename timestamp (`AUDIO-2026-10-10-15-31-04`) is the **send time** (owner-confirmed); the file's container `creation_time` is the export time and must not be used for WhatsApp files.

## Context (current code the plan relies on)

**Capture & composer**
- `src/hooks/useVoiceInput.ts` — `useAudioRecorder(RecordingPresets.HIGH_QUALITY)` (AAC `.m4a`, 44.1 kHz, 128 kbps), `MAX_RECORDING_MS = 120000`, `kickTranscription(uri)` reads the file as base64 and calls `processVoiceMemory` (`src/services/ai.ts:145`) immediately on stop; exposes the in-flight promise for post-close awaiting.
- `src/components/voice-speak-it-modal.tsx` — `captureMode: 'dictate' | 'fork' | 'keepOnly'`; auto-starts recording on open (`useEffect` → `startRecording()` ~line 131); draws the stopped clip with `seed={seedFromUri(...)}` (~line 408); hands a `VoiceKeptClip` (`localUri`, `durationMs`, `transcriptionResult` | `pendingTranscription`) to `onKeepSound`.
- `app/(app)/new-memory.tsx` — composer. `audioClip: { localUri; durationMs } | null` (line 178) is the single source of truth for "is audio". `handleKeepSound` (line 420) already implements replace-the-clip semantics incl. the "user text beats AI caption" ratchet (`hasTypedAudioNoteRef`, `lastAppliedAiCaptionRef`) and the `pendingAudioTranscriptionRef` hand-off; `handleSaveAudio` (line 527) enqueues `{ kind: 'audio', clip: { fileUri, durationMs, contentType: 'audio/mp4' }, pendingTranscription }`. `ClipChip` rendered in `noticeSlot` (~line 761) with `seed={seedFromUri(audioClip.localUri)}`. The toolbar attach button is `MemoryMediaPicker` (compact) when not audio; an inert camera icon when audio.
- `src/components/memory-media-picker.tsx` — compact attach button opens an action sheet (`ActionSheetIOS` / `Alert.alert`, ~line 339): "Photo library", "Take photo".
- `src/utils/audio-clip-custody.ts` — `claimAudioClip` (temp → app-owned `documentDirectory/audio-recordings/`), `discardAudioClip`, `sweepAudioRecordingsDirectory` (48 h startup sweep, `app-providers.tsx`).
- `src/hooks/use-suggested-memory-date.ts` — `useSuggestedMemoryDate({ attachments })` returns `memoryDate`, `setMemoryDate`, `dateSource`.

**Share-into (already live for photos/videos)**
- `app.json:139` `expo-sharing` plugin: iOS `activationRule` = attachments/images/movies ≤ 10; Android `singleShareMimeTypes`/`multipleShareMimeTypes` = `image/*`, `video/*`. The plugin also accepts a **string** NSPredicate activation rule (`node_modules/expo-sharing/plugin/build/ios/createInfoPlistFile.js`). `ContentType` includes `'audio'` and `'file'`.
- `src/hooks/use-incoming-memory-share.ts` (`useIncomingShare` → `prepareSharedMedia`), `src/utils/prepare-shared-media.ts` (accepts only `contentType === 'image' | 'video'`; error copy "Momora can only attach shared photos and videos."), `src/components/incoming-share-router.tsx` (routes to the composer).

**Save path & data**
- `src/services/memory-posting.ts` — `PostAudioMemoryInput` (line 70), `postAudioMemory` (dedicated minimal pipeline: presign/PUT/rollback, no compression/EXIF).
- `src/services/memories.ts` — `createAudioMemory` (~line 1368) inserts the `memories` row then `continueCreateMemoryWithMedia(memory, [clipAsset], …)` → `replaceMemoryMediaAssets` → RPC `replace_memory_media_assets` with `mediaAssetsToRpcPayload` (line 309: `objectKey, contentType, durationMs, aspectRatio, previewObjectKey`). `MemoryMediaAsset` interface at line 28; media rows fetched with `.from('memory_media').select('*')` (~line 283) so a new column flows to clients automatically. `MemoryMediaAssetInput` in `src/utils/memories.ts:50`.
- `replace_memory_media_assets(uuid, jsonb)` — latest definition `supabase/migrations/20260820100000_audio_memory_media_rpc.sql`: deletes and re-inserts all rows, preserving `aspect_ratio`/`preview_object_key` for an unchanged `object_key` via `existing_*` jsonb maps. Year Films has a deferred trigger on `memory_media` delete that ignores re-inserted keys (`20260929120000_year_films.sql` ~line 359).
- `memory_media` columns today: `id, memory_id, object_key, content_type, duration_ms, aspect_ratio, position, preview_object_key, share_card_key, created_at, updated_at`.
- Audio edit (`app/(app)/memory/[id]/edit.tsx`) never writes `mediaAssets` (updateMemory rejects that for non-media types).

**Server limits**
- `process-voice-memory` rejects `estimateAudioDurationSeconds(base64) > 120` (`supabase/functions/process-voice-memory/index.ts:21,274`); the estimate is `bytes / 16000` (`_shared/openai.ts:792`, i.e. assumes 128 kbps). Transcription is sent as `recording.m4a` / `audio/m4a`.
- `upload-media` caps audio at **5 MB** (`maxBytesForContentType`); content types `audio/mp4|m4a|x-m4a`; key extension `.m4a`.

**Waveform rendering**
- `src/components/audio/sound-trace.tsx` — `SoundTrace({ seed, points = 52, … })`; `moEnv(seed, n)` builds a 0.06–1 envelope (smoothing + edge taper) drawn as an alternating up/down zig-zag path. Callers pass `seed`: `stub-band.tsx`, `clip-chip.tsx`, `sound-tile.tsx`; `seedFromKey(memory.id)` in `memory-card.tsx:401`, `memory-stamp.tsx:129`, `app/(app)/family/[id]/index.tsx:132`, `pending-memory-upload-card.tsx:62`, `memory-fallback-tile.tsx:29`; `seedFromUri` in `new-memory.tsx:769` and `voice-speak-it-modal.tsx:408`. Detail `SoundStage` in `app/(app)/memory/[id]/index.tsx` (~line 633). Decorative `SoundMark` glyphs (`seed={7}`) are icons, not clips — out of scope.

**Native modules & OTA**
- Local Expo module pattern exists: `modules/momora-widget/` (`expo-module.config.json`, `ios/*.swift` + podspec, `android/` gradle, `src/`).
- Runtime policy `appVersion`; OTAs are published per runtime to older store binaries. **Any JS that imports a new native module must feature-detect it**, or the next OTA crashes older binaries. For **Expo** modules the pattern is `requireOptionalNativeModule('<Name>')` from `expo-modules-core` (see `src/utils/voice-input.ts:10`, `src/hooks/useNotifications.ts:37`); `src/lib/sentry.ts`'s `TurboModuleRegistry`/`NativeModules` check is for a plain RN module and would always report Expo modules as missing.
- `momora-widget` is **not** listed in root `package.json`/`app.json`: it is autolinked from `modules/` and imported by relative path; its podspec reads the module-local `package.json`.

**Limits & helpers the plan must change**
- `src/utils/media-validation.ts:56` `MAX_AUDIO_DURATION_MS = 2 min` is enforced client-side at upload by `assertAudioClipWithinLimits` (`src/services/memory-posting.ts:506-518`, "Recordings must be 2 minutes or shorter."), pinned by `memory-posting.test.ts` (~804/814). A 5-min import would fail at upload unless split.
- `bucketAudioDurationMs` (`new-memory.tsx:89`) maps everything > 90 s to `'90_120s'`.
- `useSuggestedMemoryDate` (`src/hooks/use-suggested-memory-date.ts`) only derives suggestions from `attachments[].capturedAtIso`; `setMemoryDate` dispatches `'user'`, which permanently freezes the date (reducer rejects later suggestions). The pill hint "Suggested from media date" keys off `dateSource === 'media'`.
- `CreateAudioMemoryInput` lives in `src/utils/memories.ts:84` (not services). `resolveAudioMemoryInsertConflict` (`src/services/memories.ts` ~1300) rebuilds its own single-asset array from `input.clip`. `PendingMemoryUpload` records (`src/hooks/use-pending-memory-uploads.tsx` ~283-295) are what `PendingMemoryUploadCard` renders. `MemoryMediaAsset` object literals also exist in `buildLegacyMediaAssets` (`src/services/memories.ts` ~216) and `src/hooks/useMemoryWidgetSync.ts:206`.
- The edit screen also draws a clip: `app/(app)/memory/[id]/edit.tsx:406` `ClipChip seed={seedFromKey(memory.id)}`.
- Android attach menu uses `Alert.alert` with Photo library / Take photo / Cancel; Android `Alert` supports **at most 3 buttons**. Compact button `accessibilityLabel` is "Attach photo or video".
- Gesture Handler gestures inside an RN `Modal` need their own `GestureHandlerRootView` (see `memory-comments-drawer.tsx`, `family-activity-sheet.tsx`, `full-screen-media-viewer.tsx`).
- `authenticated` has a table-level UPDATE grant on `memory_media` gated by RLS (TECH_SPEC §2), so the CHECK constraint, not "RPC-only writes", is the real guard on `waveform`.
- Script tests: `supabase/scripts/**` is excluded from tsconfig and Jest; script tests run under `npm run test:edge` (Deno), whose `--allow-read` includes `src/utils`. Every sibling backfill has a `.test.ts`.

**Other consumers of audio clips (no code change expected, verify)**
- Year Film worker (`cloudflare/year-film-worker/src/stages.ts` `runVoiceChecks`) cuts sound windows from audio memories and voice-checks them for "the child".
- Export worker streams `memory_media` objects type-agnostically.
- Memory book prints audio as QR + badge (no trace).

## Spike results (2026-10-10)

Reference code: [audio-trim-import-spike/AudioPrep.swift](audio-trim-import-spike/AudioPrep.swift) (macOS/iOS CLI, ~300 lines).

- Ogg Opus decodes on iOS **without libopus**: hand-rolled Ogg page demux → split every Opus packet into single-frame code-0 packets (RFC 6716 §3.2; Apple's decoder rejects multi-frame packets with `'bada'`) → `AVAudioConverter` with `kAudioFormatOpus` input (`mFramesPerPacket` = first packet's frame count) → Float32 PCM.
- **Apple's Opus decoder already drops 120 samples of priming**; drop `preSkip − 120` (not `preSkip`) and end at `finalGranule − preSkip`. With that, output is bit-exact against libopus (227 dB SNR, identical length) for 20/60/120 ms packets, on macOS, iOS 18.6 and iOS 26.5 simulators. Stereo downmix matches to 78 dB.
- AAC encoder rejected 64 kbps at a 16 kHz source rate → always resample to 48 kHz before encoding.
- 200 s file: ~1 s end-to-end on simulator. Holding 5 min of 48 kHz float PCM ≈ 57 MB/channel → the real module must **stream**.
- **Real WhatsApp iOS export** (hold → Forward → share icon): `AUDIO-2026-10-10-15-31-04.m4a`, AAC-LC 48 kHz mono 64 kbps. So the iOS share path never sees Ogg; Ogg matters for WhatsApp Web/Desktop downloads and Android (`PTT-YYYYMMDD-WAnnnn.opus`). Momora did not appear in the share sheet (expected: audio not in the activation rule).

## Design

### Native module `modules/momora-audio` (iOS Swift + Android Kotlin)

Small, dumb, testable surface. All loudness math lives in TypeScript (one implementation, shared by app + backfill), the native side only decodes and measures mean-square energy.

```ts
// modules/momora-audio/src/index.ts
export interface AudioProbe {
  durationMs: number;
  container: 'mp4' | 'ogg' | 'caf' | 'wav' | 'aiff' | 'mp3' | 'amr' | 'other';
  codec: 'aac' | 'opus' | 'pcm' | 'mp3' | 'amr' | 'other';
  sampleRate: number;
  channels: number;
  creationDate: string | null;   // container metadata, ISO; may be export time
  sizeBytes: number;
}
export interface AudioEnergies {
  durationMs: number;
  bucketMs: number;               // >= minBucketMs, chosen so count <= maxBuckets
  energies: number[];             // mean-square of mono-downmixed float PCM per bucket
}
export interface RenderResult { uri: string; durationMs: number; sizeBytes: number; }

isAvailable(): boolean;                                   // feature detection for OTA safety
probe(uri: string): Promise<AudioProbe>;                  // cheap: metadata / last Ogg granule
analyze(uri: string, opts: { maxBuckets: number; minBucketMs: number }): Promise<AudioEnergies>;
render(uri: string, opts: {
  startMs: number; endMs: number; outputUri: string;
  bitrate: number;                                        // 96000
}): Promise<RenderResult>;                                // -> AAC-LC .m4a, mono, 48 kHz
```

- **iOS Ogg is a separable phase (P1b).** The must-have (WhatsApp iOS) produces AAC `.m4a`, so iOS Ogg only matters for WhatsApp Web/Desktop downloads saved to Files. Until P1b ships, iOS returns `unsupported_format` for Ogg with copy pointing to WhatsApp's share route ("In WhatsApp, use Forward → Share → Momora instead."), and `audio_import_failed{code}` measures demand. Owner decides whether P1b is in v1 (open question).
- **Decode sources:** iOS — `AVAudioFile` for anything AVFoundation reads (m4a/AAC/ALAC, caf incl. Opus-in-CAF, wav, aiff, mp3, amr); Ogg Opus via the spike's demux + `AVAudioConverter`. Android — `MediaExtractor` + `MediaCodec`. Android's media-format table lists Opus-in-Ogg; **verify on an API 24–28 emulator** early in P1. If `MediaExtractor` handles it there, no special path; if not, return `unsupported_format` for Ogg on those versions.
- **Streaming:** decode in chunks (~1 s), downmix to mono as you go; `analyze` accumulates per-bucket sums; `render` writes encoder input chunk by chunk for the `[startMs, endMs)` window only. Never hold the whole file's PCM.
- **Output:** AAC-LC in MP4 (`.m4a`), mono, 48 kHz (iOS: `AVAudioConverter` resample; Android: resample in Kotlin with linear interpolation is acceptable for voice, or encode at source rate if 44.1/48 kHz), **96 kbps** (5 min ≈ 3.6 MB < 5 MB upload cap). iOS writer: prefer `AVAssetWriter` (writes proper gapless priming/edit-list) over `AVAudioFile`; acceptable fallback is `AVAudioFile` (≈44 ms leading encoder priming).
- **Errors:** reject with stable codes only — `unsupported_format`, `decode_failed`, `too_long`, `io_failed`. Never include file names/paths in error messages (PII).
- **Threading:** all work off the JS thread (Expo `AsyncFunction` on a background queue / coroutine).
- **Opus delay constant** (`appleOpusDecoderDelay = 120`) gets a comment pointing at the spike and a regression check (see Testing).

### Shared waveform math — `src/utils/audio-waveform.ts` (pure TS)

- `WAVEFORM_BUCKETS = 64`.
- `waveformFromEnergies(energies, { buckets = 64, startIndex?, endIndex? }) → number[]` (0–255 ints): merge fine buckets into `buckets` equal spans (mean of mean-squares) → RMS → dBFS → clamp to [−50, 0] → map to 0…1 → divide by the loudest bucket → round to 0–255. All-silent input → all zeros.
- `suggestTrim(energies, bucketMs) → { startMs, endMs } | null`: threshold = −35 dB below peak bucket; pad 250 ms on each side; return null unless it removes ≥ 600 ms total and leaves ≥ 1 s.
- `envelopeForTrace(waveform, points) → number[]` (0.06–1): linear resample to `points`, light smoothing (one pass), floor 0.06 so silence still draws a thin line. No edge taper for real data.
- Used by: the app (composer, trim sheet), the backfill script (imports this file via relative path, like `backfill-media-previews.ts` imports `src/utils/media-validation.ts`).

### Energy bucket spec (identical in Swift, Kotlin, TS, backfill)

- Mono downmix = arithmetic mean of channels, Float32 in [-1, 1].
- `bucketMs = max(minBucketMs, ceil(durationMsEstimate / maxBuckets))` (integer ms; `durationMsEstimate` from container metadata or Ogg last granule; iOS uses it unrounded, Android rounds to the nearest ms first, so exact multiples can differ by one bucket ms. Harmless: every consumer reads the returned `bucketMs`, never recomputes it).
- `samplesPerBucket = max(1, round(bucketMs * sampleRate / 1000))` at the **decoded** sample rate (no resampling for analysis).
- Bucket `i` covers decoded mono samples `[i*spb, min((i+1)*spb, n))`; `count = ceil(n / spb)`; `energies[i] = mean(x^2)` over that span (the last bucket may be partial; its mean is over its own samples).
- `durationMs = round(n * 1000 / sampleRate)` (decoded length, the value the app trusts).
- For Ogg Opus, `n` already excludes pre-skip/end trimming.
- TS reference: `energiesFromPcm(samples: Float32Array, sampleRate: number, opts: { maxBuckets: number; minBucketMs: number; durationMsEstimate?: number }) → { durationMs, bucketMs, energies }` in `src/utils/audio-waveform.ts` (estimate defaults to the exact duration).
- `waveformFromEnergies` merge: output bucket `j` (of `B`) takes the mean of fine energies `[floor(j*m/B), floor((j+1)*m/B))` within the selected range of `m` fine buckets; when that span is empty (`m < B`), use the single fine bucket `min(m-1, floor((j+0.5)*m/B))`.

### Data model — migration `supabase/migrations/20261013120000_memory_media_waveform.sql`

- `alter table public.memory_media add column waveform smallint[]` with check: `waveform is null or (cardinality(waveform) between 16 and 256 and array_position(waveform, null) is null and 0 <= all(waveform) and 255 >= all(waveform))` (the `array_position` guard matters: `0 <= all(...)` yields NULL, i.e. passes, for NULL elements). This CHECK is the real guard since `authenticated` can UPDATE `memory_media` directly under RLS.
- `create or replace function public.replace_memory_media_assets(uuid, jsonb)`: copy of the 2026-08-20 body plus: read `asset->'waveform'` (jsonb array → `smallint[]`); an **invalid waveform is stored as NULL, never raised** (a cosmetic field must not permanently fail a child's clip save, since the queue retries the same input); only accepted when `asset_content_type` is an audio type (ignored otherwise), and **preserved from the existing row when the incoming value is null and `object_key` matches** (same pattern as `aspect_ratio`, via an `existing_waveforms` jsonb map). Keep `security definer`, grants, and every existing check byte-for-byte.
- No RLS change (column rides existing `memory_media` policies). The app writes it only via the RPC; the backfill writes with the service role.
- Regenerate `src/types/database.ts` (if local Docker is down, hand-edit the `memory_media` Row/Insert/Update types and note it); update `MemoryMediaAsset` (`waveform: number[] | null`, required; then add `waveform: null` to the literals in `buildLegacyMediaAssets`, `useMemoryWidgetSync.ts:206` and test fixtures) and `MemoryMediaAssetInput` (`waveform?: number[] | null`); `mediaAssetsToRpcPayload` passes `waveform`.
- TECH_SPEC §2 (schema) + RPC contract updated in the same change.

### Real waveform rendering

- `SoundTrace` gains `waveform?: number[] | null`. When present, `envelopeForTrace(waveform, points)` replaces `moEnv(seed, points)`; when null/absent, behavior is exactly today's (seeded). `seed` stays required for the fallback.
- Thread `waveform` through `StubBand`, `ClipChip`, `SoundTile`, `SoundStage`, and every caller listed in Context: memory card, detail, **edit screen clip well** (`edit.tsx:406`), calendar stamp, member thumb, pending-upload card (new `previewWaveform` field on the `PendingMemoryUpload` record, set from the queue input), composer chip (from composer state), fork modal (from a post-stop `analyze`, guarded).
- **Explicit exception:** `memory-fallback-tile.tsx` (activity drawer, search rows, year-film moments grid) receives no `memory_media` rows and stays decorative (seeded). Fetching media there is not worth it for a thumbnail.
- Visual QA gate: the owner signs off on the real-waveform look on device (card, detail, chip) **before P2 lands on `main`**. Real waveforms are pure JS, so any routine OTA from `main` after the migration + backfill would show them to 1.4.x users. Tuning knobs are the dB floor, smoothing passes and the 0.06 floor.
- Considered and rejected for v1: deriving recording waveforms from expo-audio recorder metering (works without the module), because the loudness scale differs from the energy-based waveforms and the module is needed anyway for trim/import.

### Composer state & flows (`app/(app)/new-memory.tsx`)

`audioClip` becomes:

```ts
{
  localUri: string;          // the clip that will be saved (claimed, in audio-recordings/)
  durationMs: number;
  waveform: number[] | null; // 64 buckets of THIS clip; null if analysis unavailable/failed
  source: 'recorded' | 'imported';
  original: {                // the pre-trim source; the trim sheet always edits relative to this
    localUri: string; durationMs: number; sizeBytes: number;
    energies: AudioEnergies | null;
    uploadable: boolean;     // recorded clip, or passthrough-eligible import (AAC/MP4, <= 5:00, <= 4.5 MB)
    transcription: VoiceProcessingResult | null; // restored on a full-range Done, so no extra call
  };
  trimmed: boolean;
}
```

- **After keep (recorded):** start `analyze(localUri, { maxBuckets: 4000, minBucketMs: 20 })` and keep its promise in a ref (`pendingAnalysisRef`, identity-guarded like `pendingAudioTranscriptionRef`) → `waveform = waveformFromEnergies(...)`, energies kept on `original` for the trim sheet. Failure → `waveform: null` (seeded fallback), trim button hidden.
- **Fast save vs. analysis:** `handleSaveAudio` awaits a still-pending analysis for up to 1.5 s (analysis of a ≤ 2-min clip is well under that on device); on timeout it saves with `waveform: null` (stays seeded until a backfill re-run). No post-save patching path; accepted.
- **Trim:** `ClipChip` gets an optional `onTrim` (scissors) shown when the module is available and energies are loaded. Opens `src/components/audio/trim-sheet.tsx`:
  - Real waveform of the **original** source (~200 display buckets from energies), two drag handles (Gesture Handler `Pan`), selection shading, elapsed/selection duration labels, play-selection preview (its own `useAudioClipPlayback` instance, create-once + `replace()` per commit 25ef6be; plays from the start handle and pauses at the end handle via a new optional `stopAtSeconds` on the hook. Status updates are 250 ms apart, so the stop can overshoot by up to ~250 ms; accepted, documented. The composer chip's player is paused when the sheet opens via the coordinator), **Reset**, **Done**.
  - Opens with `suggestTrim(...)` pre-applied when it returns a range (hint copy: "We trimmed the quiet bits. Drag to adjust.").
  - Constraints: selection ≥ 1 s; ≤ cap (recorded 2:00 — always satisfied; imported 5:00). Done disabled with copy when over cap.
  - Keyboard: the sheet has no `TextInput`; it must not fight the composer's keyboard state (dismiss keyboard on open).
- **Durations come from `analyze`, not the recorder.** The recorder's `durationMillis` updates every 500 ms (`useVoiceInput.ts:58,149`), so it can be ~0.5 s short. Handle limits, full-range detection and `endMs` use the decoded duration.
- **Reset** (inside the sheet) only moves the handles back to the full range of `original`; it never swaps files by itself.
- **Done with the full range** and `original.uploadable` → the clip becomes `original.localUri` again (no render), and `original.transcription` is restored (no new call). Any other **Done →** `render(original.localUri, { startMs, endMs, outputUri: <audio-recordings/uuid.m4a>, bitrate: 96000 })` (spinner on the chip) → `analyze` the rendered file → new `waveform`. **While a render is in flight, Save and the toolbar mic are disabled** (`isProcessingAudio` state folded into `canSave`); Cancel/back marks the session abandoned and the render's completion handler discards its output (and the original) instead of applying it. Never delete a file a render may still be writing. Then **reuse the re-record path**: call the same logic `handleKeepSound` uses with a synthesized `VoiceKeptClip` whose `pendingTranscription` is a fresh transcription of the trimmed clip (see Transcription below), so the "untouched AI caption is replaceable, typed text is not" rules apply unchanged. Difference from re-record: the **original file is NOT discarded**; the previous *rendered* file is discarded when superseded. When the trimmed clip replaces the current one, **clear `audioTranscript`** first (today only a successful result writes it, `new-memory.tsx:406`), so a failed re-transcription saves `null` instead of the full clip's transcript. Auto-tags from the re-transcription go through the same `applyVoiceResult` path; if it fails, existing tags stay and the user can see/edit them. The sheet shows a one-line note when a typed/edited note exists: "Your note stays as you wrote it."

**Async re-entry (trim render, import) must read live state.** In v1 the voice modal covered the composer while a clip was claimed; in v2 the note field stays editable during a render/import that takes seconds. So the shared keep logic (extracted from `handleKeepSound` into `applyKeptClip`) must:
- read `contentRef.current`, `audioClipRef.current`, `attachedMediaRef.current` (refs already exist, `new-memory.tsx` ~241-250), never closure values;
- **OR** the typed-note ratchet (`hasTyped = hasTyped || typedNow`), never overwrite a `true` with `false`;
- carry a **generation token** (`audioOpGenerationRef`): every trim/import/re-record bumps it; a completion whose token is stale discards its output files and does nothing else;
- re-check mutual exclusion **at completion** (photos attached meanwhile → refuse + discard), and the attach button is disabled while an import is in flight.
Tests: "user edits the note during a trim render" and "user types during a share import" keep their text; a superseded import's late result is dropped.

**File ownership invariant:** a file is deleted only if it is **not** the URI handed to the queue and **not** `original.localUri` while a composer session holds it. The discard set is always de-duplicated against the saved `localUri` (an untrimmed recorded clip or a passthrough import has `audioClip.localUri === original.localUri`). For a **trim**, the "discard previous clip" step (today `new-memory.tsx:425`) skips `original.localUri`. For a **toolbar re-record or a second import**, the old `original` is discarded too (else up to 200 MB lingers 48 h).
- **Discard rules:** cancel/abandon discards current + original (deduped). Save discards `original` and superseded renders **only when they differ from the saved `localUri`**; the queue owns the saved file (retries re-read it). All files live in `audio-recordings/`, so the 48 h sweep covers a force-quit.
- **Sweep vs. fresh imports:** the sweep deletes by modification time, and a copied file may keep the source's old mtime. New files in `audio-recordings/` are named `<claimEpochMs>-<uuid>.<ext>`; `sweepAudioRecordingsDirectory` uses the name's timestamp when present (fallback: mtime). Update `audio-clip-custody.test.ts`.
- **Save-side sanitising:** the save path sends `waveform` only if it is exactly 64 finite integers in 0–255, else `null` (NaN from native energies serialises to JSON `null` elements). Test: NaN waveform → saves with null.
- **Save:** `enqueuePendingMemoryUpload({ kind: 'audio', clip: { fileUri, durationMs, contentType: 'audio/mp4', waveform } , … })` → `PostAudioMemoryInput.clip.waveform` → `postAudioMemory` → `createAudioMemory` → `clipAsset.waveform` → RPC. `pending-memory-upload-card` draws it.
- **Transcription for any clip:** extract `kickTranscription`'s body into a pure function `transcribeClip(uri, familyMembers, familyId): Promise<VoiceProcessingResult | null>` in `src/services/voice-transcription.ts`; `useVoiceInput` calls it (behavior unchanged). The server estimates duration from **bytes** (`bytes / 16000 > 120` → `AUDIO_TOO_LONG`), so the excerpt rule is keyed on both: if `durationMs > 115 s` **or** `sizeBytes > 1.75 MB`, first `render` an **excerpt** (first ≤ 115 s at 64 kbps, ≤ 0.92 MB) into `audio-recordings/` (so a force-quit is swept), transcribe that, delete it. Fresh recordings near the 2-min cap (128 kbps ≈ 1.9 MB) can also take the excerpt path; fine. When the module is unavailable, behavior is today's (send the whole file). Server size check untouched (see the `speaker` field below for the one contract addition); the description is generated from the opening of long clips, the invisible search transcript covers only that excerpt (accepted; noted in feature doc).

### Import

**Imported voice notes are usually someone else speaking** (grandma's "I miss you sweetie"). `process-voice-memory`'s cleanup maps first-person mentions to the caller's own member (`mentionedUserSelf`, `supabase/functions/_shared/prompts.ts:405`, `process-voice-memory/index.ts` ~393-400), which would auto-tag the parent. Add an optional, backward-compatible request field `speaker: 'unknown'` (family mode only; absent = today's behavior) that skips the self-mention mapping. `transcribeClip` passes it for `source: 'imported'`. Deno tests for both values; TECH_SPEC contract update; edge function deploy goes **before** the store build. Also for imports: generating copy "Writing a note about this sound…" (not "…from what you said…"), and `memory_saved.used_voice = false`.

**Entry points**
1. **Attach menu:** `MemoryMediaPicker` gets an optional `onPickSound` prop; when provided (composer, no media attached, module + picker available) the action sheet adds **"A sound or voice note"**. iOS: one more `ActionSheetIOS` option. Android: `Alert` allows only 3 buttons, so use the three actions (Photo library / Take photo / A sound or voice note) with `{ cancelable: true }` (tap-outside/back dismisses) instead of a Cancel button; if that reads badly on device, fall back to a small custom sheet. Update the compact button's `accessibilityLabel` to "Attach photo, video, or sound" when `onPickSound` is set. The sound sheet opens via `runAfterNativeChooserDismisses`. It opens `src/components/audio/bring-in-sound-sheet.tsx`: primary **"Choose from Files"** (`expo-document-picker` `getDocumentAsync({ type: ['audio/*', 'application/ogg', 'audio/ogg', 'audio/opus'], copyToCacheDirectory: true, multiple: false })`; if iOS QA shows `.opus`/`.ogg` dimmed, switch to `type: '*/*'` with extension allow-list + `probe` validation), and below it a short "From WhatsApp" guide: *Press and hold the voice note → Forward → tap the share button (bottom right) → Momora* (+ Voice Memos: *… → Share → Momora*). Guide lists only sources verified in device QA.
2. **Share sheet:** iOS — replace the `activationRule` object with a string predicate accepting up to 10 images/movies **or exactly one** `public.audio`-conforming attachment (plus `org.xiph.ogg` / `org.xiph.opus` / `public.mpeg-4-audio` identifiers explicitly). Keep it minimal; the dictionary form's semantics for mixed image+video sets must be re-verified (QA rows below). Android — add `audio/*` and `application/ogg` to `singleShareMimeTypes` only (not multiple).
   Accept a payload as audio when `contentType === 'audio'` **or** it is a `'file'` payload whose extension/mime is in the audio allow-list (`opus, ogg, oga, m4a, mp3, wav, caf, amr, aac, aiff`; `application/ogg`, `audio/*`). Android maps `application/ogg` to `file`, and iOS routes a `.opus` with a dynamic UTI to `file` with mime `application/octet-stream`, so classification by `contentType` alone would refuse them; `probe` makes the final call. `prepareSharedMedia` returns a discriminated result: `{ kind: 'media', attachments }` (today) | `{ kind: 'audio', uri, mimeType, fileName }` | error. Mixed audio + photos → error "Share one voice note at a time, or photos and videos together." `new-memory.tsx`'s `handleIncomingSharePrepared` routes `kind: 'audio'` into the import pipeline.
   Note: draft-restore currently waits on `isPreparingIncomingShare`; the audio import must count as "preparing" until the clip is in the composer so a stored draft never wins over a shared voice note.

**Mutual exclusion (audio memories are single-clip, no mixed media)**
- The sound option in the attach menu only appears when no photos/videos are attached and no clip exists (the attach button is already inert while `isAudio`).
- Voice note shared/picked while photos/videos are attached → refuse with "This memory already has photos. Save it first, then share the voice note." (nothing attached is lost).
- Photos/videos shared while a clip exists → refuse with "This memory is a sound. Save it first, then share photos." (`handleIncomingSharePrepared` must check `isAudio` before `setAttachedMedia`).
- Voice note shared while a clip exists → **replaces** it through the keep logic (discard current clip, its `original`, any superseded renders; untouched AI caption replaceable, typed note kept). Same contract as "Recording again replaces this sound".

**Modal hand-offs (iOS won't present a Modal while another is dismissing):** close the bring-in sheet and wait for its `onDismiss` before launching the document picker; `importAudioFile` never opens UI. It returns `{ kind: 'needsTrim', … }` and the composer opens the trim sheet only after the picker/previous Modal has fully dismissed.

**Import pipeline:** `src/services/audio-import.ts`, `importAudioFile({ uri, fileName, mimeType }) → ImportedClip | NeedsTrim | ImportError`:
1. Size guard (> 200 MB → `too_long`), `probe` → duration guard (> 30 min → `too_long`).
2. Copy into `audio-recordings/<claimEpochMs>-<uuid>.<ext>` (custody + sweep). Then **explicitly delete the source copy**: the picker's cache copy, and the share payload file (iOS: the extension copies it into the app-group container and `clearSharedPayloads()` only clears UserDefaults; Android: expo-sharing copies the stream into `cacheDir/<displayName>` and never removes it). Delete only after the claim copy succeeded, and only paths inside the app-group container / app cache (never a user's Files location). Otherwise a child's voice note lingers outside `audio-recordings/` indefinitely. (The existing photo/video share path has the same leak; spawn a separate task for it, don't widen this one.)
3. `analyze` (energies for trim sheet + waveform).
4. If duration > 5:00 → return `needsTrim`; the composer opens the trim sheet in "must trim" mode (initial selection: `suggestTrim` start + 5:00, or 0–5:00). Cancel → abort import, discard.
5. Else, **passthrough** if `codec === 'aac' && container === 'mp4' && sizeBytes <= 4.5 MB` (no generation loss; WhatsApp iOS / Voice Memos typical) — else `render` the full range.
6. Date: `parseVoiceNoteDate(fileName)` — WhatsApp iOS `AUDIO-YYYY-MM-DD-HH-MM-SS`, WhatsApp Android `PTT-YYYYMMDD-WA\d+` / `AUD-YYYYMMDD-WA\d+`; else `probe.creationDate` **only if** it is > 15 min before now (an export-time stamp is ignored); else no suggestion. Never a future date. **Applied as a suggestion, not a user edit:** extend `useSuggestedMemoryDate` with an optional `audioCapturedAtIso` input that dispatches `'media'` (attachment and audio dates can't coexist; see mutual exclusion); clearing the clip clears the suggestion. Never call `setMemoryDate` (that freezes the date as `'user'`). Pill hint when the suggestion came from audio: "Suggested from the voice note's date".
7. Into the composer as `source: 'imported'`, via the same keep logic (fresh transcription, auto-tags, AI description).
8. Errors → composer `errorMessage` with friendly copy per code: `unsupported_format` "Momora can't open this kind of sound file yet." / `too_long` "That recording is longer than 30 minutes." / other "Couldn't open that sound. Try again."

**Playable original:** the trim sheet previews `original` with expo-audio (AVPlayer on iOS), which can't play Ogg. If the source isn't AAC/MP4 (or MP3/WAV/CAF on iOS), step 3 first `render`s the **whole** source (≤ 30 min, 96 kbps ≈ 21 MB) to an intermediate `.m4a` in `audio-recordings/` and that becomes `original` (source copy deleted). Later renders then never touch Ogg again.

**Early size checks:** reject before copying where the platform tells us the size (picker `size`, share payload `contentSize`); delete any copy that was already made on reject.

**Copy rules** (VoC §6): "a sound", "voice note", "keep the sound". Never "audio file", "audio note", "upload audio".

### Feature detection & OTA safety

- `modules/momora-audio/src/index.ts` resolves the native module with `requireOptionalNativeModule('MomoraAudio')`; `isAvailable()` false on older binaries → trim button hidden, "A sound or voice note" option hidden, composer saves recorded clips with `waveform: null`.
- `expo-document-picker` is **never statically imported** from code reachable on older binaries: wrap it in `src/utils/document-picker.ts` that checks the native module (`ExpoDocumentPicker`) before a lazy `require`, mirroring `src/lib/sentry.ts`.
- `SoundTrace`'s `waveform` path is pure JS → older binaries receiving the OTA also render real (backfilled/new) waveforms. Treat `waveform` `undefined` (rows from persisted TanStack caches written before the column existed) the same as `null`.
- An OTA ships the **whole** JS bundle: the reshaped composer, new share handling and picker menu all reach 1.4.x runtimes with the module absent. Jest covers the composer, picker menu and share handling with `isAvailable() === false` (no trim, no sound option, audio shares refused with "Update Momora to bring in voice notes.").
- `app.json` `version` bump (1.4.3 → 1.5.0) for the new runtime.

### Backfill — `supabase/scripts/backfill-audio-waveforms.ts` + `npm run backfill:audio-waveforms`

Follows `backfill-media-previews.ts`: dry-run by default, `--apply`, `--limit N`, `--memory-id`, `--concurrency` (default 4); env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_*` (no new secrets). Selects `memory_media` rows with `content_type in (audio types) and waveform is null`; presigned GET → temp file → `ffmpeg -i <tmp> -ac 1 -ar 48000 -f f32le -` (Deno.Command) → energies at the same bucket scheme → `waveformFromEnergies` → `update memory_media set waveform = … where id = … and waveform is null`. Logs only row ids and counts (no keys of other users beyond ids, no content). Deletes temp files. **Run only with owner approval** (service-role write to prod): dry-run first, then `--memory-id` pilot, then `--apply`.

### Analytics (`src/services/analytics.ts`)

- `audio_memory_saved` + `source: 'recorded' | 'imported'`, `trimmed: boolean`, `duration_bucket` gains `'120_300s'` (update `bucketAudioDurationMs` in `new-memory.tsx:89`: > 120 s → `'120_300s'`).
- New: `audio_trim_opened` (`source`, `suggested: boolean`), `audio_trim_applied` (`source`, `removed_bucket`), `audio_import_started` (`entry: 'share' | 'picker'`), `audio_import_failed` (`entry`, `code`). No content, file names, or durations finer than buckets.

## Steps

Phases are ordered by dependency. P1–P4 can be developed in parallel after P0; release order is in P8.

### P0 — Foundations
1. `src/utils/audio-waveform.ts` + `src/utils/audio-waveform.test.ts`: `WAVEFORM_BUCKETS`, `waveformFromEnergies`, `suggestTrim`, `envelopeForTrace`; tests for silence, single loud bucket, normalization, range slicing, trim suggestion thresholds/padding/min-length.
2. `src/utils/voice-note-date.ts` + tests: `parseVoiceNoteDate(fileName, now)`, `pickImportedMemoryDate({ fileName, creationDate, now })`.
3. Migration `20261013120000_memory_media_waveform.sql` (column + check + RPC re-definition with waveform parse/validate/preserve). pgTAP `supabase/tests/memory_media_waveform.sql`: valid write; via RPC, out-of-range / wrong length / NULL elements → stored NULL (save succeeds); via direct UPDATE, the CHECK rejects them; ignored for image rows, preserved on re-save with null, replaced when provided.
4. Types: `database.ts` memory_media `waveform`, `MemoryMediaAsset.waveform` (+ literals in `buildLegacyMediaAssets`, `useMemoryWidgetSync.ts`, fixtures), `MemoryMediaAssetInput.waveform`, `mediaAssetsToRpcPayload`.
4b. Split the duration cap in `src/utils/media-validation.ts`: `MAX_RECORDING_DURATION_MS = 2 min` (recorder semantics; `useVoiceInput`'s `MAX_RECORDING_MS` stays) and `MAX_AUDIO_UPLOAD_DURATION_MS = 5 min + 1 s`; `assertAudioClipWithinLimits` uses the upload cap with copy "Sounds must be 5 minutes or shorter."; update the comment and `memory-posting.test.ts` (add a 4:30 pass case and a 5:02 fail case).
4c. `src/utils/audio-waveform.ts` must have **no `@/` alias or React Native imports** (Deno-importable by the backfill). Add a golden-vector fixture (`src/utils/__fixtures__/waveform-golden.json`: synthetic PCM recipe → expected energies/waveform) consumed by the Jest test, the Deno backfill test and `verify-macos.sh`.

### P1 — Native module `modules/momora-audio`
5. Scaffold like `momora-widget` (`expo-module.config.json` modules `MomoraAudioModule` / `expo.modules.momoraaudio.MomoraAudioModule`, podspec, gradle, `src/index.ts` with optional-module resolution + typed API above). Module-local `package.json`; autolinked from `modules/` and imported by relative path, so no root `package.json` change. Resolve with `requireOptionalNativeModule('MomoraAudio')`.
6. iOS (`ios/`): `AudioDecoder.swift` (chunked mono PCM reader over AVAudioFile, with a pluggable source so Ogg can slot in), `MomoraAudioModule.swift` (`probe`, `analyze`, `render` with AVAssetWriter AAC 48 kHz mono 96 kbps), stable error codes.
7. Android (`android/`): `MediaExtractor`/`MediaCodec` decoder (chunked, mono downmix), `MediaCodec` AAC encoder + `MediaMuxer` (MP4), resample to 48 kHz, `probe`/`analyze`/`render`, stable error codes. First task: check Ogg Opus extraction on an API 24–28 emulator and pick the path (see Design).
6b. **(P1b, optional, owner decision)** iOS `OggOpus.swift`: port the spike's demux, packet split and decode, including the 120-sample delay, as an `AudioDecoder` source.
8. `modules/momora-audio/scripts/verify-macos.sh`: compiles the iOS decoder core (shared Swift files that don't import ExpoModulesCore) into a macOS CLI and checks committed synthetic fixtures (generated by ffmpeg `lavfi` tones/noise, **no human voices** — repo is public) against libopus output length/SNR and expected energies. Documented in the feature doc; not in CI.

### P2 — Real waveforms in the UI
9. `SoundTrace` `waveform` prop + tests (fallback to seed when null; envelope from waveform when present).
10. Thread `waveform` through `StubBand`, `ClipChip`, `SoundTile`, `SoundStage`, memory card, detail, `memory-stamp`, `family/[id]`, pending-upload card, fork modal (post-stop `analyze`, guarded). Update the corresponding component/screen tests.

### P3 — Save path
11. `PostAudioMemoryInput.clip.waveform`, `postAudioMemory`, `CreateAudioMemoryInput.clip.waveform` (`src/utils/memories.ts:84`), `createAudioMemory` → RPC payload, **and `resolveAudioMemoryInsertConflict`'s rebuilt asset array**; `PendingMemoryUpload.previewWaveform` in `use-pending-memory-uploads.tsx`. Tests: `memory-posting.test.ts`, `memories.integration.test.ts` (waveform round-trips incl. the conflict-repair path; null when absent), `use-pending-memory-uploads.test.tsx`.

### P4 — Trim
12. `src/services/voice-transcription.ts` (`transcribeClip`, excerpt for > 115 s) + refactor `useVoiceInput` to use it (existing tests must stay green).
13. `src/components/audio/trim-sheet.tsx` (RN `Modal` wrapping its own `GestureHandlerRootView`, like `memory-comments-drawer.tsx`) + tests (handles, min/max selection, suggested range, Reset, Done disabled over cap, preview playback calls).
14. `ClipChip` `onTrim` + busy state; composer state reshape (`audioClip` fields above), trim Done/Reset wiring reusing the keep logic, discard rules. Tests in `new-memory.integration.test.tsx`: trim replaces clip + re-transcribes; typed note survives trim; untouched AI caption is replaced; Reset restores original; cancel discards original + renders; save enqueues trimmed file with waveform; saving an untrimmed clip / a full-range Done never deletes the uploaded file; trim with failed re-transcription saves `audio_transcript: null`; Reset only moves handles; Save disabled during render; cancel during render discards the render output on completion; save during pending analysis waits ≤ 1.5 s; module unavailable → no trim button.

### P5 — Import
15. `src/utils/document-picker.ts` (`requireOptionalNativeModule('ExpoDocumentPicker')` check, then lazy `require('expo-document-picker')`), `expo-document-picker` dependency (`npx expo install`).
16. `src/services/audio-import.ts` (`importAudioFile`) + tests (guards, passthrough vs render decision, date choice, error mapping, custody/discard).
17. `bring-in-sound-sheet.tsx` + `MemoryMediaPicker` `onPickSound` option + composer wiring (must-trim mode for > 5 min, mutual-exclusion rules, `useSuggestedMemoryDate` `audioCapturedAtIso`). Tests incl. `use-suggested-memory-date.test.tsx` and the media-picker menu (iOS + Android 3-action Alert, accessibility label).
18. Share-into: `app.json` expo-sharing iOS string predicate + Android mime types; `prepareSharedMedia` discriminated result; `use-incoming-memory-share` / `new-memory.tsx` routing (incl. the `isAudio` guard before `setAttachedMedia`); draft-restore gating. Update `prepare-shared-media` / `use-incoming-memory-share` / `incoming-share-router` tests.

### P6 — Backfill script
19. `supabase/scripts/backfill-audio-waveforms.ts` + `backfill-audio-waveforms.test.ts` (Deno, under `npm run test:edge`, which has no `--allow-run` and CI has no ffmpeg: inject the ffmpeg runner; test bucketing on a committed tiny f32le PCM fixture / the golden recipe; candidate selection; idempotent `waveform is null` update. The real-ffmpeg comparison is a manual local check) + npm script; dry-run on prod (read-only) to report counts; **ask owner** before `--apply`.

### P7 — Docs, analytics, e2e
20. Analytics event types + call sites.
21. `docs/features/audio-memories.md`: update the AI-cost note (each trim Done costs one transcription + cleanup; imports up to 5 min with a 115 s transcription excerpt), new sections (trim, import, waveforms, native module, OTA guards, transcription excerpt, backfill), update "Do not change without updating this doc" (import is not a second *kind* of kept audio — same type, different source), changelog. `docs/TECH_SPEC.md` (schema, RPC, module). CLAUDE.md/AGENTS.md voice-pipeline line: "kept or imported clips persist to private R2".
22. Maestro flows (authored; run in device pass): `trim-audio-memory.yaml` (record → keep → trim → save), `import-audio-memory.yaml` (picker path with a fixture pushed to the simulator/emulator).

### P8 — Release order
23. Deploy migration (backward compatible: new nullable column; old clients' RPC payloads lack `waveform` → null; old RPC callers unaffected).
24. Run backfill (owner-approved).
25. Store build 1.5.0 (`app.json` version bump; momora-audio, expo-document-picker, expo-sharing config). Device QA matrix below.
26. OTAs from then on ship the full main bundle to every live runtime (1.5.0 plus 1.4.x via the per-runtime version-revert procedure in `project_ota_releases` memory / feature doc). The older-binary QA row runs on that exact bundle.
27. **Backfill re-runs:** new null-waveform rows keep appearing (1.4.x binaries, analysis timeouts, module failures). Re-run the backfill (idempotent) ~2 weeks after 1.5.0 release and then monthly until 1.4.x usage is negligible; add "null-waveform audio rows count" to the release checklist.

## Implementation notes (2026-10-10)

- iOS mp3 decode via AVAudioFile does not trim encoder delay/padding (~+40 ms vs ffmpeg); AAC is exact. Expect small mp3 duration differences between iOS and Android.
- AAC output bitrate is a target (Apple's long-term-average strategy): quiet/tonal content lands well under 96 kbps; speech near it.
- Android `render` on AAC input may start with a few ms of decoder priming (Android ignores MP4 edit lists).
- `modules/momora-audio/scripts/verify-macos.sh` (172 checks, macOS + iOS simulator) is the iOS core's regression harness; run it after touching `modules/momora-audio/ios/*`.

## Device QA matrix (must pass before store submission)

- iOS: record → keep → trim (suggested + manual) → save → card/detail waveform matches what was heard; Reset; cancel.
- iOS share: WhatsApp (hold → Forward → share icon → Momora), Voice Memos, Files `.m4a`, Files `.opus` (WhatsApp Web download); Momora appears for audio, still appears for photos/videos, does **not** appear for PDFs.
- iOS picker: `.m4a`, `.mp3`, `.wav`, `.caf`; `.opus`/`.ogg` either import (if P1b shipped, incl. trim-sheet preview playback) or show the WhatsApp-share copy.
- Picker on a > 5-min file → bring-in sheet closes, picker, then the trim sheet appears in must-trim mode (Modal hand-offs).
- Non-parent speaker import (someone saying "I miss you"): the parent is **not** auto-tagged.
- Typing in the note during a trim render / share import keeps the typed text.
- Android (API ≥ 29 and one 24–28): WhatsApp share (`.opus`), recorder app `.m4a`, picker; attach menu shows three actions and dismisses on tap-outside; Ogg on the older API either works or shows the `unsupported_format` copy (whichever P1 chose).
- Mutual exclusion: share a voice note into a composer with photos → refused, photos intact; share photos into a sound composer → refused; share a second voice note → replaces.
- Share sheet regressions: mixed photos + video, 10 vs 11 photos (same behavior as 1.4.3); a `.opus` file from Files appears for Momora (or document that it doesn't and the picker is the path).
- Untrimmed recorded clip and passthrough import both upload successfully (file-ownership invariant); after an import, no copy remains in the app-group container / cache.
- 6-min import → forced trim to ≤ 5:00; 31-min file refused; 4-min import transcribes (excerpt) and saves under 5 MB.
- Date: WhatsApp file gets the send time's date; Voice Memos file gets its recording date; plain file → today.
- Older binary (1.4.3) with the new OTA: no trim/import UI, no crash, real waveforms render for backfilled memories.
- Year film: an imported 5-min clip and a trimmed clip both prepare without errors (staging/dogfood family).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| OTA to older binaries crashes on a missing native module | `requireOptionalNativeModule` + guarded lazy `require` for document picker; explicit QA row on 1.4.3. |
| Apple changes the Opus decoder's internal priming | Constant isolated + `verify-macos.sh` regression check against libopus; QA on newest iOS. Worst case is 2.5 ms of offset, not a failure. |
| Memory blow-up on long files | Streaming decode/encode; 30 min / 200 MB hard ceiling. |
| Upload cap exceeded | Imported/trimmed output is 96 kbps mono (5 min ≈ 3.6 MB); passthrough only when ≤ 4.5 MB. |
| Transcription rejected for > 2-min clips | 115 s excerpt sent; server untouched. |
| Late transcription clobbers user note after trim | Trim reuses `handleKeepSound`'s ratchet + `pendingAudioTranscriptionRef` identity guard; tests cover both orders. |
| Orphaned child audio on disk (force-quit mid-trim/import) | All files (originals, renders, imports) live in `audio-recordings/`; existing 48 h sweep. Share/picker cache copies deleted after claim. |
| Share extension shows Momora for every file type (App Review / UX) | String predicate restricted to images/movies/audio UTIs; QA checks PDFs don't match. |
| WhatsApp/iOS UI changes the share path | Guide copy is in one component; QA verifies; analytics `audio_import_started{entry}` shows whether share is used. |
| Real waveform looks jittery vs. the hand-inked design | `envelopeForTrace` smoothing/floor knobs; owner visual sign-off gate. |
| Backfill writes to prod | Dry-run default, pilot on one memory, owner approval, `where waveform is null` idempotency. |
| Imported clip features an adult (grandma), year film voice check expects "the child" | Expected and fine — voice check skips non-child windows; no change. |

## Addendum: post-save trim (v2.1, owner-approved 2026-10-10)

**Status: implemented 2026-10-10 (pending device QA + release).** Code: `src/hooks/use-saved-audio-trim.ts`, `app/(app)/memory/[id]/edit.tsx`, `useMemories.ts` `updateMutation` (`audioClip`), `uploadAudioClipObject` in `memory-posting.ts`, `updateMemory` + `UpdateMemoryInput.audioTranscript`. Documented in [docs/features/audio-memories.md](../features/audio-memories.md) ("v2.1"). Implementation notes: the edit-screen state machine lives in the `useSavedAudioTrim` hook rather than inline; the trim button stays visible while a download/render is in flight even if connectivity drops (so the spinner does not vanish), and is hidden while the save mutation runs.

Owner defaults: **permanent** (confirm before saving: "The part you cut will be gone for good."), **keep the note as is**, **who can trim = who can edit** (`canEditFamilyContent`), **online only**. No migration.

Flow (edit screen `app/(app)/memory/[id]/edit.tsx`):
1. The recessed clip well gets the scissors (`ClipChip onTrim`) when `MomoraAudio.isAvailable()`, the user can edit, and the device is online (`useIsOnline`); offline tap → "Trimming needs a connection." The "Kept as recorded" caption and "This sound cannot be re-recorded." hint stay (re-record is still impossible); when a trim is pending the caption reads "Trimmed — saves when you tap Save".
2. Tap → `processing` on the chip → download the current clip (signed URL from `useMediaUrl`) with `FileSystem.downloadAsync` to `newAudioRecordingUri('m4a')` → `analyze` → `TrimSheet` (`maxSelectionMs` 300_000, `mustTrim` false, `suggested` from `suggestTrim`, `hasUserNote` = note non-empty). The downloaded file is the session's `original` (Reset works within the session; "Done" with the full range clears any pending trim).
3. Done (not full range) → `render` (96 kbps) → `analyze` → pending trim `{ localUri, durationMs, sizeBytes, waveform, range }`; the chip previews the local trimmed file (playback + real waveform). Re-opening the trim sheet edits relative to the downloaded original (initial range = pending range).
4. Save with a pending trim → `Alert` confirm ("Trim this sound?" / "The part you cut will be gone for good." / Cancel / "Trim and save") → the edit mutation uploads the trimmed `.m4a` via the **audio** upload path (`uploadMediaObject` + `buildMemoryMediaAssetKey(user.id, memoryId, newAssetId, 'm4a')`, same as `postAudioMemory`; NEVER `uploadMemoryMediaAssets`, which is the photo/video pipeline), pushes the key to `uploadedKeys` for rollback, then `updateMemory(..., { mediaAssets: [{ objectKey, contentType: 'audio/mp4', durationMs, waveform }], audioTranscript: null, ... })`.
5. `updateMemory`: allow `mediaAssets` for `memoryType === 'audio'` only when it is exactly one audio asset (`audio/mp4|m4a|x-m4a`); anything else keeps the existing `invalid_memory_type` error. New optional `UpdateMemoryInput.audioTranscript` (audio only) clears the hidden transcript in a separate `memories` update written **after the clip replace succeeds** (the old transcript describes the cut parts; a failed RPC leaves the still-current clip's transcript intact). The existing removed-key cleanup deletes the old R2 object after the RPC succeeds.
6. After a successful save, fire-and-forget `transcribeClip(trimmedLocalUri, members, familyId, { durationMs, sizeBytes })` (no `speaker`: post-save it only feeds the description/transcript patch, which never touches tags) → `patchAudioDescriptionIfEmpty(memoryId, { description, transcript })` (content filled only if the note is empty; transcript always). Then discard the local files (downloaded original + renders). Cancel/back discards them too. Never block navigation on transcription.
7. Analytics: `audio_trim_applied { source: 'saved', removed_bucket }` (extend the `source` union with `'saved'`), `audio_trim_opened { source: 'saved', suggested }`.

Side effects (verified, no code change): Year Films referencing the old key are invalidated by `year_films_on_memory_media_deleted` (re-render); book QR codes resolve the current clip live via `workers/memory-viewer`; other devices refresh via `updated_at`.

Tests: `memories.integration.test.ts` (audio single-asset replace allowed; multi/non-audio rejected; transcript cleared; old key deleted), `useMemories` edit-mutation test (audio upload path, rollback on RPC failure), `edit-memory.integration.test.tsx` (trim button gating: unavailable / offline / no permission; download→sheet→done→preview; Save shows confirm; Cancel in confirm doesn't save; confirmed save sends the new asset; full-range Done clears pending; cancel discards files; transcription backfill fired after save).

## Out of scope

- ~~Trimming after save (V2)~~ — now the v2.1 addendum above. Re-recording a saved clip stays out of scope.
- Raising the in-app recording cap above 2 minutes.
- Multiple clips per audio memory; importing several voice notes at once (one at a time only).
- Server-side transcoding; bundling libopus.
- Waveforms in the printed memory book or share cards (audio is QR-only / rejected there).
- Looking Back audio frame (still v2 backlog from v1).
- Web platform.
