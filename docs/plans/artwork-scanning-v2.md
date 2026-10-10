# Artwork v2: soul

**Status:** implemented 2026-10-10 on branch `feature/audio-artwork-combined`
(worktree `~/Coding/Momora2-artwork`); steps A-E done, awaiting device
verification and merge. Shipped behavior and extension notes:
[`docs/features/artwork.md`](../features/artwork.md). Approved design 2026-10-10
(owner).
**Design reference:** design canvas https://claude.ai/artifact/Mg1cuh4NYxq3KCoQcQ55zF
(boards: Frame styles, Timeline, Timeline batch deck, Memory detail one piece,
Memory detail batch gallery walk, First-time intro and reveal, Composer toolbar
icons, Frame component). Builds on v1 (`docs/plans/artwork-scanning.md`,
`docs/features/artwork.md`).

## Goal

Artwork stops looking like "a photo with a border". On the Timeline it hangs
like a framed piece on a wall, a scrapbook object alongside the ticket (audio)
and the quote (text). On the detail page it hangs on a gallery wall. Both use
playful, randomly assigned frames. The composer gets three new hand-drawn
toolbar icons, a first-time intro before scanning, and a swing-in reveal when
a new artwork lands on the Timeline.

## Owner decisions (do not re-litigate)

1. **Six frame styles × six colors,** any style in any color. A combination
   is picked at random, plus a slight tilt (about ±1° to ±2.5°).
   - Styles: scallop, gingham, ric-rac, wavy, bobble, chunky.
   - Colors: blush `#F2A7B8`, sky `#4A8FD6`, mint `#8FD1AA`, lilac `#C4ADE6`,
     butter `#F2C84B`, tomato `#E2553F`.
   - Bobble uses the color for its beads, on a cream band (`#FFF6DF`).
   - Gingham uses it for the checks, on white.
   - Chunky is a thick flat band with a wavy inner mat edge.
   - Every style has a cream mat (`#FFFDF7`) and a hairline inner shadow at
     the opening.
2. **"Random" must be stable.** Derive it deterministically from the media
   asset's id with `seedFromKey` (`src/components/audio/audio-seed.ts`), so a
   piece always hangs in the same frame at the same tilt on every device and
   render. No schema change.
3. **Timeline single piece: no white card.**
   - The framed piece hangs directly on the Timeline background with a soft
     cast shadow.
   - Below it: a handwritten (Caveat) title from the caption, omitted when
     the caption is empty, and "Artist, age" in small sans
     (`formatTaggedMemberAge` for the first tagged member; omit if none).
   - Then the normal engagement row and the date footer with the medium chip
     (or the "Artwork" fallback badge).
   - No nail or string on the Timeline.
4. **Timeline batch: a deck.**
   - Up to 3 frames are stacked at different angles. The front piece uses its
     own tilt; the back slots are about +6° and −7°, offset as on the canvas.
   - A paper tag reads "n of N".
   - Swiping horizontally flings the front piece off, and it tucks in at the
     back of the pile, like a pack of cards. The next piece comes forward.
   - Tapping opens the detail on the front piece (`mediaIndex`).
   - Only the first 3 pieces are drawn in the stack; the counter still cycles
     through all N.
5. **Detail: a gallery wall.**
   - Warm plaster background `#EEE3D3` with a faint noise texture and a
     diagonal light streak.
   - The frame hangs from a nail and string.
   - A small museum placard sits under it:
     - title in Newsreader italic;
     - artist + full age, e.g. "Mara, 2 years 4 months" (use the existing
       full-age formatter);
     - "<Medium> on paper · <Month D, YYYY>". For a batch, medium ·
       "N pieces" · date. Without a medium, drop that part.
   - Then the standard `MemoryEngagementBar` (like / comment / share).
     **Comments open the existing `MemoryCommentsDrawer`**, with no inline
     comment preview.
   - Then the member pills and the meta footer.
6. **Detail batch: a horizontal "gallery walk".**
   - A snapping horizontal carousel. The current piece is centered; the
     previous and next pieces, frames included, peek about 55px in from the
     screen edges. Nothing peeks at either end.
   - No per-piece "1 of 3" labels on the detail page.
   - Tapping the current piece opens the existing full-screen viewer at that
     index. Tapping a peeking piece scrolls to it.
7. **First-time intro.**
   - The first time a user taps Scan artwork, a bottom sheet shows: an
     illustration (a framed doodle on a plaster panel), eyebrow
     "NEW · ARTWORK", title "Let's hang it on the wall", body "Scan your kid's
     drawings and they'll show up framed on your Timeline.", two tips, and a
     primary "Start scanning" button.
   - Tip 1: **Lay it flat** — "Smooth out folds so the edges come out
     straight."
   - Tip 2: **Use a darker surface** — "A wooden table or the floor helps the
     scanner find the paper."
   - It's shown once per device (AsyncStorage flag). "Start scanning" closes
     it and launches the scanner; dismissing it doesn't scan.
8. **Reveal.**
   - It plays once, on the Timeline, when a newly posted artwork memory
     replaces its pending-upload card.
   - The frame drops in from 40px above, tilted 9° (380ms ease-out). It then
     swings about a top-center pivot in two damped swings (~900ms) and
     settles at its own tilt. The label fades in last.
   - With reduce motion on, it's a plain fade.
   - Only for posts made in this app session, never for memories loaded from
     the server or refetched.
9. **New composer icons,** custom SVG, each an ink outline plus one color:
   - Sound: a retro mic with sea-green sound waves.
   - Photos & videos: two stacked instant photos, the top one sunny.
   - Scan artwork: a scalloped pink frame with a squiggle and a sun.

   They replace the mic, the media-picker button, the scan button and their
   disabled placeholders, in both new-memory and edit-memory. When disabled,
   all strokes and fills go grey.
10. **Unchanged:**
    - the mic dictates the caption only (no audio + artwork);
    - batches stay;
    - the full-screen viewer shows the bare scan;
    - every other surface still shows artwork as a photo.

## Context (current code on this branch)

- **v1 frame:** `src/components/artwork-frame.tsx` (walnut band, cream mat,
  `size: 'card' | 'detail'`). It is used by `src/components/memory-card.tsx`
  (`SpreadCard` media branch when `isArtworkMemory`) and by
  `app/(app)/memory/[id]/index.tsx` (`MemoryDetailFramed` artwork branch:
  `artworkWall`, `artworkBody`, `ArtworkFrame size="detail"` wrapping a
  `MemoryMediaCarousel`).
- **Medium chip / badge:** `src/components/artwork-medium-chip.tsx`
  (`ArtworkMediumTag`).
- **Card dispatch:** `MemoryCard` (`memory-card.tsx` ~line 516) routes
  `text_only` to `QuoteCard`, `audio` to `SoundCard`, everything else to
  `SpreadCard`. Add an `ArtworkCard` branch for `isArtworkMemory(memory)`.
- **Detail:** the screen already wires `MemoryCommentsDrawer` (`onOpenComments`)
  and `FullScreenMediaViewer` (`fullScreenIndex`). `activeMediaAsset` /
  `setActiveMediaIndex` drive share-current-page.
- **Composer toolbar:**
  - The mic button lives in `src/components/memory-composer-form.tsx`
    (`SymbolView` mic).
  - The media button is `MemoryMediaPicker`'s compact button
    (`src/components/memory-media-picker.tsx`).
  - The scan button is `src/components/artwork-scan-button.tsx`.
  - Inert / disabled placeholders live in `app/(app)/new-memory.tsx` (the
    `isAudio` branch) and `app/(app)/memory/[id]/edit.tsx` (non-media and
    artwork placeholders).
  - This branch includes audio-trim's composer: `useComposerAudioClip`, the
    bring-in-a-sound sheet, and `onPickSound` in the picker.
- **Pending upload → memory:** `src/hooks/use-pending-memory-uploads.tsx`
  `runUpload` calls `prependMemoryToListCaches` then `removeUpload` on
  success. That is the "posted this session" moment.
- **Libraries:** `react-native-svg` 15.15.4 (`Path`, `Circle`, `Rect`,
  `Pattern`, `Defs`), `react-native-reanimated` 4.3.1,
  `react-native-gesture-handler` 2.31, `expo-linear-gradient`,
  `@react-native-async-storage/async-storage`. RN 0.85 supports the
  `transformOrigin` style. The Caveat and Newsreader fonts are already loaded
  (`fonts.script`, `fonts.displayItalic` in `src/constants/theme.ts`).
- **Design canvas source:** `Frame.dc.html` holds the reference geometry
  (`edgePath`, `roundRect`, bead layout, gingham pattern). Port that logic.
  Its local copy is at
  `/private/tmp/claude-501/-Users-eduardoyi-Coding-Momora2/05b4c722-2a98-4f8d-8578-25d35a3e8131/scratchpad/design/project/Frame.dc.html`
  (read it).
- **Maestro testIDs:** keep `memory-card-<id>-artwork-frame` (Timeline) and
  `memory-detail-artwork-frame` (detail).

## Steps

### A. Frame engine + icons (do first; B, C and D depend on it)

**A1. `src/components/artwork/frame-geometry.ts`** (pure, no RN imports):
- `frameMetrics(artW, artH)` → `{ band, mat, amp, w, h }`, using the canvas
  formula:
  - `base = min(artW, artH)`;
  - `band = max(16, round(base*0.12))`;
  - `mat = max(10, round(base*0.085))`;
  - `amp = round(band*0.42)`.
- `framePaths(kind, metrics)` → SVG path strings + circle lists for: outer
  body, corner circles, beads, mat (rect, or wavy for chunky), lip, outline.
  These are the same shapes as `Frame.dc.html`.
- Memoize by key `(kind, artW, artH)`.
- Unit tests:
  - each kind returns closed paths;
  - the frame's outer box equals `w`×`h`;
  - the scallop/wavy period divides each side evenly;
  - bead counts are sane.

**A2. `src/components/artwork/frame-style.ts`:**
- `pickFrameStyle(key: string)` → `{ kind, color, tilt }`, deterministic via
  `seedFromKey`. Spread kind and color independently (e.g. kind =
  `seed % 6`, color = `floor(seed / 6) % 6`). Tilt in [−2.5, −1] ∪
  [1, 2.5], derived from another slice of the seed.
- Export `FRAME_KINDS` and `FRAME_COLORS`.
- Tests:
  - stable for the same key;
  - covers all 36 combinations over many keys;
  - tilt stays within range.

**A3. Rewrite `src/components/artwork-frame.tsx`** as an SVG frame:
- Props: `{ artWidth, aspectRatio, kind, color, tilt?, nail?: boolean, children, testID, style }`.
- The children (the image) are absolutely positioned in the mat opening, at
  `artWidth × artWidth/aspectRatio`. The hairline inner shadow is an overlay
  View with an inset border.
- **Shadow:** RN SVG has no reliable blur, and Android elevation is
  rectangular. Draw a soft cast shadow inside the SVG instead: 3 offset
  copies of the body path (offsets about (2,4), (4,7), (6,10); opacities
  about 0.10, 0.07, 0.04; color `#46301A`). The SVG viewport is padded so
  shadow and string aren't clipped.
- **Nail + string** (when `nail`): a dark nail dot 30px above the top center,
  and a string from about 26% and 74% of the top edge to the nail. Drawn
  inside the same SVG, which is rotated along with the frame.
- **Rotation:** `transform: [{ rotate }]`. With `nail`, the
  `transformOrigin` is the nail; otherwise top-center (needed for the reveal).
- Export `getArtworkFrameSize(artWidth, aspectRatio)` for layout.
- Replace the walnut tokens in `src/constants/theme.ts` with the frame
  palette tokens (`frameBlush`…`frameTomato`, `frameCream`, `frameMat`,
  `frameShadow`). Remove the walnut tokens if nothing else uses them.
- Rewrite `artwork-frame.test.tsx`.

**A4. `src/components/icons/composer-icons.tsx`:**
- Components: `SoundIcon`, `PhotosIcon`, `ScanArtIcon`, all
  `react-native-svg`. Props: `size` (default 28), `disabled`.
- Port the 48-viewBox paths from the canvas `Icons.dc.html` (in the same
  scratchpad folder as `Frame.dc.html`; read it). Use the toolbar-weight
  stroke widths (2.2–2.4 at 28px).
- When `disabled`, every stroke and fill becomes `colors.ink3` / `#E6E1DD`.
- Swap them in:
  - the composer form mic;
  - `MemoryMediaPicker`'s compact button icon (compact mode only);
  - `ArtworkScanButton`;
  - every inert placeholder in `new-memory.tsx` and `edit.tsx`.

  Keep accessibility labels unchanged. Snapshot/structure tests.

### B. Timeline: wall card, deck, reveal (after A; files: memory-card.tsx + new components)

**B1. `src/components/artwork/artwork-card.tsx` (`ArtworkCard`):**
- Mounted from the `MemoryCard` dispatch when `isArtworkMemory(memory)`.
  Remove the artwork branch from `SpreadCard`.
- **Single piece:** a centered `ArtworkFrame`, style from
  `pickFrameStyle(asset.id)`. Art width ≈ 50% of the list's content width
  (the canvas used 196px of 358px). Clamp the frame height to ≤ 420px by
  shrinking the width for tall art.
- Then the label (Caveat 30 title; 13px ink2 artist line), the
  `MemoryEngagementBar` (as `SpreadCard` passes it) and `CardFooter` (keep
  the medium chip). Reuse `CardFooter` from `memory-card.tsx`, exported or
  moved.
- **Tap targets:** tapping the frame calls `onPress(memory.id, frontIndex)`,
  as the media card does today. That means `memoryDetailRoute(id, mediaIndex)`;
  check how `SpreadCard` forwards the carousel page index and mirror it.
- testIDs: `memory-card-<id>` on the root and
  `memory-card-<id>-artwork-frame` on the front frame.

**B2. `src/components/artwork/artwork-deck.tsx`** (batch, 2+ assets):
- Up to 3 visible frames at the slot offsets and tilts from the canvas
  (`ClusterDeck.dc.html`: front at the center with its own tilt; back-right
  +6°, offset (+70, −85); back-left −7°, offset (−89, −31), scaled to the
  card width).
- **Gesture:** a gesture-handler `Pan` with `activeOffsetX([-12, 12])` and
  `failOffsetY([-10, 10])`, so vertical list scrolling still wins. On release
  past ~30% of the width (or a fast fling), the front card animates out
  (translate to −1.2×width, rotate −16°, 260ms), then re-enters at the back
  slot (z-order flipped when the out-animation ends). Order state is local,
  in a `useState` array of asset indices.
- A tap opens detail at the front piece's index.
- **Tag:** a paper tag "n of N" (Caveat 22, white, 5° tilt, small shadow).
- **Height:** stable, based on the max frame height across the visible 3.
- **Accessibility:** `accessibilityActions` with `increment` = next piece,
  plus a hint.

**B3. Reveal:**
- `src/utils/artwork-reveal.ts` holds an in-memory `Set` of memory ids,
  `markArtworkForReveal(id)` and `consumeArtworkReveal(id)` (returns true
  once).
- In `use-pending-memory-uploads.tsx`, after a successful post of an input
  with `mediaVariant === 'artwork'`, call `markArtworkForReveal(memory.id)`
  before `prependMemoryToListCaches`.
- `ArtworkCard`, on mount, calls `consumeArtworkReveal`. If true, it runs the
  Reanimated sequence:
  - translateY −40→0 and rotate 9°→tilt via `withSequence` (drop 380ms
    `Easing.out(cubic)`, then `withSpring` to the tilt with damping tuned to
    about 2 visible swings);
  - the label opacity 0→1 after ~700ms.
- With reduce motion (`AccessibilityInfo.isReduceMotionEnabled`), use an
  opacity fade only.
- Tests:
  - the utility's semantics;
  - the card consumes it once;
  - reduce-motion takes the fade path (mock reanimated per existing patterns).

**B4. Update tests:**
- `memory-card.test.tsx`: the artwork branch now renders `ArtworkCard` (no
  white card); label with and without caption and tagged member; the deck for
  multiple assets; testIDs.
- New `artwork-card.test.tsx` and `artwork-deck.test.tsx`: gesture is hard in
  Jest, so test the order-cycling logic as an extracted pure reducer.

### C. Detail: gallery wall + gallery walk (after A; files: detail screen + new components)

**C1. Gallery wall backdrop:**
- `src/components/artwork/gallery-wall.tsx`: a full-screen background View
  `#EEE3D3` with a tiling noise texture at opacity 0.09, plus a diagonal
  `LinearGradient` light streak (about 120°,
  `rgba(255,249,236,0) → 0.6 → 0`).
- Texture: generate `assets/textures/plaster-noise.png` (128×128 greyscale
  noise; commit a script or a one-off; tiny file) and use `ImageBackground`
  with `resizeMode="repeat"`.

**C2. Rewrite the artwork branch of `MemoryDetailFramed`:**
- **Single piece:** `ArtworkFrame` with `nail`, style from
  `pickFrameStyle(asset.id)` (the same one the Timeline shows). Art width
  ≈ 64% of screen width; clamp the frame height to ~480.
- **Placard:** `src/components/artwork/museum-placard.tsx` (cream,
  radius 3, small shadow, content per decision 5).
- Then the existing `MemoryEngagementBar` (comments open the drawer — verify
  no inline comment preview renders in this branch), the member pills, and
  `MemoryMetaFooter` with `isArtwork`.
- Keep the back and more buttons; restyle them as translucent white circles
  on the wall if the current header doesn't already read well on plaster.
- testID `memory-detail-artwork-frame` on the (current) frame.

**C3. Batch: `src/components/artwork/gallery-walk.tsx`:**
- A horizontal `FlatList` with `snapToInterval = slideSpacing` (≈ 0.67 ×
  screen width, so neighbours peek about 55px), `decelerationRate="fast"`,
  and horizontal content padding of `(screenWidth − slideSpacing)/2`, so the
  first and last pieces center and nothing peeks past the ends.
- Each slide is an `ArtworkFrame` with `nail`, its own `pickFrameStyle`
  style, vertically centered in a fixed-height track.
- `initialScrollIndex` = the `mediaIndex` route param. `onMomentumScrollEnd`
  → `setActiveMediaIndex`, which keeps share-current-page working.
- Tapping the current slide → `setFullScreenIndex(i)`; tapping a neighbour →
  `scrollToIndex`.
- testIDs: `memory-detail-artwork-frame` on the current slide's frame;
  `memory-detail-gallery-walk` on the list.

**C4. Tests:** update `memory-detail.integration.test.tsx`:
- single: placard content, nail, the comments icon opens the drawer;
- batch: the gallery walk renders N slides, `initialIndex`, and active index →
  share target;
- tap → full-screen viewer.

### D. Composer: first-time intro (after A; files: artwork-scan-button + new sheet)

**D1. `src/components/artwork/artwork-intro-sheet.tsx`:**
- A bottom sheet `Modal`, following existing sheet patterns: the
  bring-in-sound sheet is the closest; check its safe-area and keyboard
  handling.
- Contents as in decision 7. The illustration is an `ArtworkFrame` (bobble,
  butter) holding a simple SVG crayon doodle (no bundled photo), on a small
  plaster panel.
- Respect the bottom inset.

**D2. Gate:** in `ArtworkScanButton`, before the permission check, read the
AsyncStorage key `momora.artwork.introSeen.v1`.
- If not seen: set it, show the sheet, and launch the scan only when
  "Start scanning" is pressed. The sheet must have fully dismissed first
  (iOS won't present VisionKit over a dismissing Modal); use the same
  dismiss-gate pattern as the bring-in-sound sheet.
- If seen: scan directly.
- Storage errors fall through to scanning. They never block.

**D3. Tests:** first tap shows the sheet and doesn't scan; Start scanning
scans after dismissal; second tap scans directly; a storage error goes
straight to the scan.

### E. Docs + verification

- Update `docs/features/artwork.md`:
  - **New:** frame engine, `pickFrameStyle` determinism, wall card, deck,
    reveal, gallery wall/walk, intro, icons.
  - **Extending:** how to add a frame style or color (`FRAME_KINDS`,
    `frame-geometry.ts`); why style is derived and not stored (a future "change
    frame" needs a column that overrides the derived pick).
  - Changelog row.
- Update `docs/plans/artwork-scanning-v2.md` status.
- Run `npx tsc --noEmit`, `npm run lint`, the full `npm test`. Device check
  by the owner on the dev builds (this is all JS, so it runs on the existing
  dev clients).

## Risks

- **Timeline performance:**
  - SVG frames with many points (scallop/wavy polylines) in a virtualized
    list. Memoize geometry per `(kind, w, h)`. Keep a ~2px step on long
    sides.
  - Avoid re-rendering on scroll: `MemoryCard` is memoized; keep
    `ArtworkCard` pure.
- **Gesture conflicts:** the deck's pan vs the vertical list scroll vs the
  swipe-back gesture. Use offsets as specified; test on device.
- **Shadow look:** the stacked offset copies are approximate. If it reads
  badly on device, iOS-only `shadow*` on a transparent container is a
  fallback (iOS follows the alpha); Android keeps the SVG shadow.
- **Reveal timing:** the card can mount off-screen, e.g. when the list is
  scrolled away. Acceptable: it still plays once on mount. Never replay on
  refetch: consume is one-shot.
- **Determinism:** `pickFrameStyle` must use the asset id. For legacy
  single-asset rows with a synthetic asset, fall back to the memory id.

## Out of scope

- Letting parents choose or change the frame; any schema change.
- Frames on surfaces beyond the Timeline and detail.
- Native scanner UI copy (system-owned).
