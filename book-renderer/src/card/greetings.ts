import type { CardGreetingKey, CardLanguage } from './types';

/** The card greeting (front heading and back heading). Mirrors
 * `supabase/functions/_shared/holiday-card-letter.ts` (`CARD_GREETINGS`), which
 * makes the letter's closing wish match. */
export const GREETINGS: Record<CardLanguage, Record<CardGreetingKey, string>> = {
  es: {
    christmas: 'Feliz Navidad',
    holidays: 'Felices fiestas',
    'new-year': 'Feliz Año Nuevo',
  },
  en: {
    christmas: 'Merry Christmas',
    holidays: 'Happy Holidays',
    'new-year': 'Happy New Year',
  },
};

export function greetingText(language: CardLanguage, key: CardGreetingKey): string {
  return GREETINGS[language][key];
}

/** Tiny "made with Momora" footnote (no URL). */
export function madeWithText(language: CardLanguage): { before: string; brand: string } {
  return language === 'es' ? { before: 'hecho con', brand: 'Momora' } : { before: 'made with', brand: 'Momora' };
}
