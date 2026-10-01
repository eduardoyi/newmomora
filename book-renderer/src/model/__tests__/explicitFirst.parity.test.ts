import { describe, expect, it } from 'vitest';
import { hasExplicitFirstLanguage as renderer } from '../explicitFirst';
// The worker's own helper (pure TS, no imports) — the source of truth this module mirrors.
import { hasExplicitFirstLanguage as worker } from '../../../../cloudflare/memory-book-worker/src/firsts';

// The worker's table (cloudflare/memory-book-worker/test/firsts.test.ts) plus extra edge cases.
const POSITIVE = [
  'Hoy fue su primer corte de pelo',
  'Su primera palabra fue mamá',
  'Los primeros pasos!',
  'Las primeras gotas de lluvia',
  'Lo probó por primera vez',
  'Fue la primera vez que se rió',
  'Ayer, el primer día de escuela',
  'Her first haircut today',
  'It was the first time he walked',
  'He tried it for the first time',
  'Foi o primeiro banho de mar',
  'Ela deu a primeira risada',
  'Provou pela primeira vez',
  'PRIMER CUMPLEAÑOS',
  'PRIMÉR dia',
  'First!',
  'the-first-step',
  'Primeiros passos\nlinha dois',
];
const NEGATIVE = [
  '',
  'Fuimos a cortarnos el pelo',
  'Se subió a la bici sin pedales',
  'Firstborn of the family tree',
  'Firsts and seconds',
  'reprimer imprimer',
  'comprimera',
  'primavera en el parque',
  'Primo Luis vino a verlo',
  'primero fue el helado, luego el parque',
  'Mara aprendió a lanzar besitos.',
];

describe('explicit-first rule parity (renderer copy vs worker helper)', () => {
  it.each(POSITIVE)('both match %j', (text) => {
    expect(worker(text)).toBe(true);
    expect(renderer(text)).toBe(true);
  });
  it.each(NEGATIVE)('neither matches %j', (text) => {
    expect(worker(text)).toBe(false);
    expect(renderer(text)).toBe(false);
  });
  it('null / undefined agree', () => {
    for (const v of [null, undefined]) expect(renderer(v)).toBe(worker(v));
  });
});
