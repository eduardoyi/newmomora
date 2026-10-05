import { useEffect, useMemo, useState } from 'react';
import { FocalPointModalView } from '../../web/edits/FocalPointModalView';
import { buildCardDocument, cardStats, type CardDocument, type RegionTarget } from '../document';
import {
  changeGreeting,
  emptyEdits,
  resetFocal,
  resetLetter,
  resetText,
  setChoices,
  setFocal,
  setFrontImage,
  setLetter,
  setText,
  type CardEdits,
  type TextTarget,
} from '../edits';
import { cardInputFromData, defaultFrontId, frontOptionsOf, letterFor, resolveFront } from '../fromData';
import { greetingText } from '../greetings';
import { createCanvasMeasure, ensureCardFonts } from '../measure';
import { CARD_GREETING_KEYS, LETTER_TONES, parseCardData, type CardData, type CardGreetingKey } from '../types';
import { CardPhotoPicker } from './CardPhotoPicker';
import { DevPanel } from './DevPanel';
import { EditableSheet, type FieldState } from './EditableSheet';
import { localPhotoProvider } from './photoProvider';
import { useCardEdits } from './useCardEdits';
import './preview.css';

/**
 * The card editor preview (docs/plans/holiday-cards.md C3). User mode (default):
 * the card large and centred, a slim control strip (Layout, Letter version,
 * Greeting, Film QR, Change photo), click any text to edit it in place, hover
 * the picture for Replace / Reposition. Developer mode (`?dev=1`): guides, zoom,
 * readouts, overrides. It renders the same components `card:pdf` prints.
 */

const MM_PX = 96 / 25.4;
const TONE_LABEL: Record<string, string> = { classic: 'Classic', short: 'Short', playful: 'Playful', reflective: 'Reflective' };

function useCardIndex(): string[] | null {
  const [cards, setCards] = useState<string[] | null>(null);
  useEffect(() => {
    fetch('/card-index.json')
      .then((r) => r.json())
      .then((j: { cards: string[] }) => setCards(j.cards))
      .catch(() => setCards([]));
  }, []);
  return cards;
}

function useCardData(slug: string | null): { data: CardData | null; error: string | null } {
  const [state, setState] = useState<{ data: CardData | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/${slug}/card.json?ts=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`card.json: ${r.status}`))))
      .then((j) => !cancelled && setState({ data: parseCardData(j), error: null }))
      .catch((e: unknown) => !cancelled && setState({ data: null, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [slug]);
  return state;
}

function useFonts(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    ensureCardFonts().then(() => setReady(true), (e) => console.error(e));
  }, []);
  return ready;
}

/** The element's live width. A callback ref (not useRef) because the stage only mounts after the card has loaded. */
function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(1100);
  useEffect(() => {
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** Applies the open draft (live typing) on top of the saved edits, without saving. */
function withDraft(edits: CardEdits, draft: { target: RegionTarget; value: string } | null): CardEdits {
  if (!draft) return edits;
  if (draft.target === 'letter') return setLetter(edits, edits.choices.tone, draft.value);
  return setText(edits, draft.target as TextTarget, draft.value);
}

export function CardPreviewApp() {
  const params = new URLSearchParams(window.location.search);
  const dev = params.get('dev') === '1';
  const cards = useCardIndex();
  const [slug, setSlug] = useState<string | null>(params.get('slug'));
  useEffect(() => {
    if (!slug && cards && cards.length > 0) setSlug(cards[0]);
  }, [cards, slug]);
  const { data, error } = useCardData(slug);
  const fontsReady = useFonts();
  const { edits, ready: editsReady, update, saveError } = useCardEdits(slug);

  const [active, setActive] = useState<RegionTarget | null>(null);
  const [draft, setDraft] = useState<{ target: RegionTarget; value: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focalOpen, setFocalOpen] = useState(false);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [devState, setDevState] = useState({ trim: true, safe: true, bleed: false, zoom: 0 });
  const [stageRef, stageWidth] = useElementWidth<HTMLDivElement>();
  const [viewportH, setViewportH] = useState(window.innerHeight);
  useEffect(() => {
    const on = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const assetUrl = useMemo(() => (file: string) => `/${data?.slug ?? slug}/${file}`, [data, slug]);
  const provider = useMemo(() => (data ? localPhotoProvider(data, assetUrl) : null), [data, assetUrl]);

  const shown = useMemo(() => withDraft(edits, draft), [edits, draft]);
  const result = useMemo(() => {
    if (!data || !fontsReady || !editsReady) return null;
    try {
      return { doc: buildCardDocument(cardInputFromData(data, shown, assetUrl), createCanvasMeasure()), error: null as string | null };
    } catch (e) {
      return { doc: null as CardDocument | null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, shown, fontsReady, editsReady, assetUrl]);
  const doc = result?.doc ?? null;

  // Close any open editor when the card itself changes.
  useEffect(() => {
    setActive(null);
    setDraft(null);
  }, [slug]);

  if (!cards) return <div className="cp-empty">Loading…</div>;
  if (cards.length === 0) return <div className="cp-empty">No cards yet. Run <code>npm run eval:holiday-card-assets</code> from the repo root.</div>;
  if (error) return <div className="cp-empty">{error}</div>;
  if (!data) return <div className="cp-empty">Loading card…</div>;

  const choices = edits.choices;
  const front = resolveFront(data, edits);
  const isIllustration = front.option.kind === 'illustration';
  const currentGreeting: CardGreetingKey = choices.greeting ?? data.greeting;
  const qrOn = choices.qr ?? data.qr.enabled;
  const tones = LETTER_TONES.filter((t) => data.letters.some((l) => l.tone === t));

  // Fields as shown in the editor (saved edit, else the generated default).
  const greeting = greetingText(data.language, currentGreeting);
  const fields: Record<RegionTarget, FieldState> = {
    'front.greeting': { value: edits.text['front.greeting'] ?? greeting, edited: edits.text['front.greeting'] !== undefined },
    'front.subline': { value: edits.text['front.subline'] ?? String(data.year), edited: edits.text['front.subline'] !== undefined },
    'back.heading': { value: edits.text['back.heading'] ?? greeting, edited: edits.text['back.heading'] !== undefined },
    letter: { value: letterFor(data, choices.tone, edits), edited: edits.letters[choices.tone] !== undefined },
    'back.signature': { value: edits.text['back.signature'] ?? data.signature, edited: edits.text['back.signature'] !== undefined, placeholder: 'Con cariño…' },
    'back.qrCaption': { value: edits.text['back.qrCaption'] ?? data.qrCaption ?? '', edited: edits.text['back.qrCaption'] !== undefined },
  };

  // Gentle warning while typing: block (never shrink) when it would not fit.
  let warning: string | null = null;
  let blockSave = false;
  if (draft && doc) {
    if (!doc.back.letter.fit.fits) {
      warning = draft.target === 'letter' ? 'This is too long: it would drop below 9 pt. Shorten it a little to keep it readable.' : 'There isn’t room for that: it would push the letter below 9 pt.';
      blockSave = true;
    } else if (doc.safeViolations.length > 0) {
      warning = 'That is too wide for the card: it would run too close to the edge.';
      blockSave = true;
    }
  }

  function saveText(target: RegionTarget, value: string) {
    if (target === 'letter') update((e) => setLetter(e, e.choices.tone, value));
    else update((e) => setText(e, target as TextTarget, value));
    setActive(null);
    setDraft(null);
  }
  function resetField(target: RegionTarget) {
    if (target === 'letter') update((e) => resetLetter(e, e.choices.tone));
    else update((e) => resetText(e, target as TextTarget));
    setActive(null);
    setDraft(null);
  }

  // Layout geometry: two sheets side by side when they fit, else one sheet with a Front/Back toggle.
  const pageW = doc?.geometry.pageW ?? 185.8;
  const pageH = doc?.geometry.pageH ?? 135;
  const gap = 32;
  const pad = 24;
  const avail = Math.max(280, stageWidth - pad * 2);
  const heightCap = Math.max(1.5, (viewportH - 230) / pageH);
  const sideBySide = (avail - gap) / (2 * pageW) >= 2.5;
  const autoZoom = Math.min(sideBySide ? (avail - gap) / (2 * pageW) : avail / pageW, 4.6, Math.max(heightCap, sideBySide ? 2.5 : 1.5));
  const zoom = dev && devState.zoom > 0 ? devState.zoom : autoZoom;
  const showFront = sideBySide || side === 'front';
  const showBack = sideBySide || side === 'back';
  const stats = doc ? cardStats(doc) : null;
  const imageId = front.option.id;
  const savedFocal = edits.focalPoints[imageId] ?? (imageId === defaultFrontId(data) ? (data.photo.focal ?? null) : null);

  const common = {
    zoom,
    overlays: dev ? { trim: devState.trim, safe: devState.safe, bleed: devState.bleed } : undefined,
    editable: true,
    fields,
    activeTarget: active,
    warning,
    blockSave,
    onOpenText: (t: RegionTarget) => {
      setActive(t);
      setDraft(null);
    },
    onDraft: (value: string) => active && setDraft({ target: active, value }),
    onCloseText: () => {
      setActive(null);
      setDraft(null);
    },
    onSaveText: saveText,
    onResetText: resetField,
    onReplace: () => setPickerOpen(true),
    onReposition: () => setFocalOpen(true),
  };

  return (
    <div className={`cp${dev ? ' cp--dev' : ''}`}>
      <div className="cp-body">
        <header className="cp-strip" role="toolbar" aria-label="Card options">
          {!isIllustration && (
            <div className="cp-field" role="group" aria-label="Layout">
              <span className="cp-field__label">Layout</span>
              <div className="cp-chips">
                {([['bordered', 'Bordered'], ['full-bleed', 'Full-bleed']] as const).map(([k, label]) => (
                  <button key={k} type="button" className={`cp-chip${choices.layout === k ? ' on' : ''}`} onClick={() => update((e) => setChoices(e, { layout: k }))}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="cp-field" role="group" aria-label="Letter version">
            <span className="cp-field__label">Letter</span>
            <div className="cp-chips">
              {tones.map((t) => (
                <button key={t} type="button" className={`cp-chip${choices.tone === t ? ' on' : ''}`} onClick={() => update((e) => setChoices(e, { tone: t }))}>
                  {TONE_LABEL[t] ?? t}
                </button>
              ))}
            </div>
          </div>
          <label className="cp-field">
            <span className="cp-field__label">Greeting</span>
            <select className="cp-select" value={currentGreeting} onChange={(e) => update((x) => changeGreeting(x, e.target.value as CardGreetingKey))}>
              {CARD_GREETING_KEYS.map((k) => (
                <option key={k} value={k}>
                  {greetingText(data.language, k)}
                </option>
              ))}
            </select>
          </label>
          <label className="cp-field cp-field--check">
            <input type="checkbox" checked={qrOn} onChange={(e) => update((x) => setChoices(x, { qr: e.target.checked }))} />
            <span>Film QR</span>
          </label>
          <button type="button" className="cp-primary" onClick={() => setPickerOpen(true)}>
            Change photo
          </button>
        </header>

        <main className="cp-stage" ref={stageRef}>
          {!sideBySide && (
            <div className="cp-flip" role="tablist" aria-label="Card side">
              {(['front', 'back'] as const).map((s) => (
                <button key={s} type="button" role="tab" aria-selected={side === s} className={`cp-chip${side === s ? ' on' : ''}`} onClick={() => { setSide(s); setActive(null); setDraft(null); }}>
                  {s === 'front' ? 'Front' : 'Back'}
                </button>
              ))}
            </div>
          )}
          {result?.error && <div className="cp-empty">{result.error}</div>}
          {!doc && !result?.error && <div className="cp-empty">Loading…</div>}
          {doc && (
            <div className="cp-sheets">
              {showFront && (
                <figure>
                  {dev && <figcaption>Front</figcaption>}
                  <EditableSheet doc={doc} side="front" {...common} />
                </figure>
              )}
              {showBack && (
                <figure>
                  {dev && <figcaption>Back</figcaption>}
                  <EditableSheet doc={doc} side="back" {...common} />
                </figure>
              )}
            </div>
          )}
          <p className="cp-hint">
            Tap any text to edit it. {saveError && <span className="cp-warn">Couldn’t save to disk (kept in this browser).</span>}
          </p>
        </main>
      </div>

      {dev && (
        <DevPanel
          cards={cards}
          slug={slug}
          onSlug={setSlug}
          data={data}
          edits={edits}
          stats={stats}
          state={devState}
          onState={setDevState}
          zoom={zoom}
          onChoices={(patch) => update((e) => setChoices(e, patch))}
          onResetAll={() => update(() => emptyEdits())}
        />
      )}

      {pickerOpen && provider && (
        <CardPhotoPicker
          provider={provider}
          currentId={imageId}
          canReset={edits.frontImage !== null}
          currentOrientation={doc?.geometry.orientation ?? 'landscape'}
          onPick={(item) => {
            update((e) => setFrontImage(e, item.id === defaultFrontId(data) ? null : item.id));
            setPickerOpen(false);
          }}
          onReset={() => {
            update((e) => setFrontImage(e, null));
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {focalOpen && doc && (
        <FocalPointModalView
          url={assetUrl(frontOptionsOf(data).find((o) => o.id === imageId)?.file ?? data.photo.file)}
          targetAspect={doc.front.image.boxAspect}
          initial={savedFocal}
          saving={false}
          resetting={false}
          error={null}
          onSave={(p) => {
            update((e) => setFocal(e, imageId, p));
            setFocalOpen(false);
          }}
          onReset={() => {
            update((e) => resetFocal(e, imageId));
            setFocalOpen(false);
          }}
          onClose={() => setFocalOpen(false)}
        />
      )}
    </div>
  );
}

export { MM_PX };
