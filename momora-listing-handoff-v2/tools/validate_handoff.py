#!/usr/bin/env python3
"""Validate the v2 handoff's copy and structure, not live app/store readiness.

Usage: python3 momora-listing-handoff-v2/tools/validate_handoff.py
No network access or third-party dependencies are required.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main() -> int:
    errors: list[str] = []
    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)
    try:
        data = json.loads((ROOT / 'approved-listing-copy.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        print(f'Cannot read the copy registry: {exc}', file=sys.stderr)
        return 1
    check(data.get('schema_version') == 2, 'Expected schema_version 2.')
    check(data.get('brief_version') == '2.0-memory-first', 'Expected v2 brief.')
    check(data.get('strategy') == 'memory-first', 'Default strategy must be memory-first.')
    fields = {
        'name': ('name.txt', 30, 'name_characters', False),
        'subtitle': ('subtitle.txt', 30, 'subtitle_characters', False),
        'promotional_text': ('promotional-text.txt', 170, 'promotional_text_characters', False),
        'description': ('description.txt', 4000, 'description_characters', False),
        'keywords_candidate': ('keywords-candidate.txt', 100, 'keywords_utf8_bytes', True),
        'whats_new_proposed': ('whats-new-proposed.txt', 4000, 'whats_new_characters', False),
    }
    counts: dict[str, int] = {}
    for key, (filename, limit, countkey, byte_limit) in fields.items():
        value = data.get(key)
        if not isinstance(value, str):
            errors.append(f'{key}: missing or not text.')
            continue
        check(bool(value.strip()), f'{key}: empty.')
        count = len(value.encode('utf-8')) if byte_limit else len(value)
        counts[countkey] = count
        check(count <= limit, f'{key}: {count} exceeds {limit}.')
        check(data.get('counts', {}).get(countkey) == count, f'{key}: recorded count is stale.')
        try:
            actual = (ROOT / 'copy' / 'en-US' / filename).read_text(encoding='utf-8')
            check(actual == value, f'{filename}: registry/export mismatch, including whitespace.')
        except OSError as exc:
            errors.append(f'{filename}: {exc}')
        for forbidden in ('TODO', 'TBD', '{{', '}}', '<description>', '**'):
            check(forbidden not in value, f'{key}: public placeholder or markup {forbidden!r}.')
        for old in data.get('superseded_active_strings', []):
            check(old not in value, f'{key}: old active v1 text survives: {old!r}.')
    ids = [
        '01-more-than-photos', '02-existing-photos', '03-unphotographed-stories',
        '04-little-voice', '05-optional-book', '06-private-family', '07-look-back',
    ]
    slides = data.get('screenshots', [])
    check([s.get('id') for s in slides] == ids, 'Default frame order differs from v2.')
    check([s.get('position') for s in slides] == list(range(1, 8)), 'Invalid default positions.')
    if len(slides) == 7:
        check(slides[0].get('headline') == 'Keep more than\nthe photos.', 'Default hero is not v2.')
        check('sold separately' in (slides[4].get('disclosure') or ''), 'Print qualifier missing.')
        check('Shipping extra.' in (slides[4].get('disclosure') or ''), 'Shipping qualifier missing.')
    commercial = data.get('commercial_context', {})
    check(commercial.get('print_optional') is True, 'Print must remain optional.')
    check(commercial.get('print_included_in_subscription') is False, 'Do not imply included print.')
    check(commercial.get('price_changes_authorized') is False, 'No price changes authorized.')
    check(commercial.get('annual_app_membership_amount') == 99, 'Owner reference annual amount changed.')
    check(commercial.get('printed_book_amount') == 99, 'Owner reference print amount changed.')
    challengers = data.get('opener_challengers', [])
    check([c.get('id') for c in challengers] == ['existing-photo-first', 'voice-first'],
          'Expected digital-value opener challengers, not v1 print challengers.')
    for challenger in challengers:
        check(challenger.get('replace_screen') == ids[0], 'Opener must replace only first frame.')
        check(challenger.get('unchanged_positions') == [2, 3, 4, 5, 6, 7],
              'Opener manifest must hold 2–7 unchanged.')
    required = [
        'MASTER-BRIEF.md', 'README.md', 'COMMERCIAL-CLARITY.md', 'REBASE-FROM-V1.md',
        'state.example.json', 'reference/voice-of-customer.md',
        'reference/momora-app-store-conversion-review.md',
        'prompts/00-rebase-existing-work.md', 'prompts/01-ground-truth-and-setup.md',
        'prompts/02-listing-text-and-metadata.md', 'prompts/03-capture-product-proof.md',
        'prompts/04-render-full-listing-and-variants.md', 'prompts/05-independent-qa-and-release-pack.md',
    ]
    for rel in required:
        check((ROOT / rel).is_file(), f'Missing required handoff file: {rel}')
    for path in ROOT.rglob('*'):
        check(path.suffix.lower() not in {'.ttf', '.otf', '.woff', '.woff2'},
              f'Font file must not be packaged: {path.relative_to(ROOT)}')
    report = {
        'brief_version': data.get('brief_version'),
        'scope': 'Handoff consistency and literal copy limits only; NOT live product, pricing, image or release QA.',
        'status': 'pass' if not errors else 'fail',
        'counts': counts,
        'errors': errors,
        'not_verified': [
            'Live feature availability and screenshot capture provenance',
            'Localized prices, book-preparation entitlement, shipping and legal links',
            'Final store images, native device captures, rendering pipeline and experiments',
            'Customer understanding, willingness to pay, conversion and retention',
        ],
    }
    (ROOT / 'COPY-VALIDATION.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if not errors else 1

if __name__ == '__main__':
    raise SystemExit(main())
