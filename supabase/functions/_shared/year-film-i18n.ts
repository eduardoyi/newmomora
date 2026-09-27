// Year Film on-screen labels and journal-language detection
// (docs/plans/year-film.md §12 Q12). Films speak the language the family
// writes in — the printed book's rule (resolveOutlineLanguage: the journal's
// own language first, the family setting as fallback).
//
// These are fixed template labels (hand-written translations of the topic
// and milestone catalogs), not AI text. English labels come from the
// catalogs themselves.
import { getMilestoneById } from './memory-milestones.ts';
import { getTopicById } from './memory-topics.ts';

export type FilmLanguage = 'en' | 'es';

/** Spanish topic titles — playful, gender-neutral where Spanish allows. */
export const TOPIC_TITLES_ES: Readonly<Record<string, string>> = {
  'beach': 'Un día de playa',
  'lake-river': 'Junto al agua',
  'pool-water': '¡Al agua!',
  'snow-play': 'Días de nieve',
  'mountains-hiking': 'En la montaña',
  'outdoors-nature': 'En la naturaleza',
  'countryside-farm': 'Vida de campo',
  'camping': 'Bajo las estrellas',
  'park-playground': 'Días de parque',
  'days-out': 'Grandes salidas',
  'out-and-about': 'De paseo',
  'travel': 'Aventuras lejos de casa',
  'eating-out': 'Comiendo fuera',
  'mealtime': 'A la mesa',
  'cooking-baking': 'En la cocina',
  'treats': 'Dulces antojos',
  'bath': 'Hora del baño',
  'bedtime-sleep': 'Dulces sueños',
  'mornings': 'Buenos días',
  'baby-care': 'Cuidándote',
  'helping-chores': 'Ayudando en casa',
  'tough-days': 'Los días difíciles',
  'doctor-dentist': 'Día de chequeo',
  'moving-new-home': 'Un nuevo hogar',
  'outfits-style': 'Con mucho estilo',
  'pretend-play': 'Disfraces y fantasía',
  'arts-crafts': 'Arte y manualidades',
  'sensory-messy-play': 'A ensuciarse',
  'toys-building': 'Bloques, trenes y juguetes',
  'books-reading': 'La hora del cuento',
  'music-dance': 'Música y baile',
  'bikes-scooters': 'Sobre ruedas',
  'sports-exercise': 'En movimiento',
  'pregnancy-expecting': 'Antes de que llegaras',
  'newborn-days': 'Los primeros días',
  'words-and-sayings': 'Cosas que dijiste',
  'big-kid-skills': 'Creciendo',
  'grandparents': 'Con los abuelos',
  'extended-family': 'Tíos, tías y primos',
  'friends': 'Amigos',
  'animals-pets': 'Amigos peludos',
  'birthday': '¡Cumpleaños!',
  'valentines': 'San Valentín',
  'mothers-fathers-day': 'Día de mamá y papá',
  'christmas': 'Navidad',
  'new-year': 'Año Nuevo',
  'thanksgiving': 'Acción de Gracias',
  'halloween': 'Halloween',
  'easter': 'Pascua',
  'lunar-new-year': 'Año Nuevo Lunar',
  'hanukkah': 'Janucá',
  'eid': 'Eid',
  'diwali': 'Diwali',
  'dia-de-muertos': 'Día de Muertos',
  'national-holiday': 'Fiestas nacionales',
  'other-holiday': 'Fiestas y festivales',
  'wedding': 'Día de boda',
  'ceremony': 'Una ceremonia especial',
  'family-gathering': 'Todos juntos',
  'school': 'Días de escuela',
  'faith-and-traditions': 'Nuestras tradiciones',
};

/** Spanish milestone labels (share-sensitive ones included for
 * completeness; films never show them). */
export const MILESTONE_NAMES_ES: Readonly<Record<string, string>> = {
  'first-smile': 'Primera sonrisa',
  'holds-head-up': 'Sostiene la cabeza',
  'rolls-over': 'Se da la vuelta',
  'sits-up': 'Se sienta sin ayuda',
  'crawling': 'Empieza a gatear',
  'pulls-to-stand': 'Se pone de pie',
  'first-steps': 'Primeros pasos',
  'walking': 'Camina con confianza',
  'climbing': 'Empieza a trepar',
  'running': 'Empieza a correr',
  'first-jump': 'Primer salto',
  'balance-bike': 'Primera bici sin pedales',
  'bike-training-wheels': 'Bici con rueditas',
  'bike-no-training-wheels': 'Bici sin rueditas',
  'swims-unassisted': 'Nada sin ayuda',
  'first-somersault': 'Primera voltereta',
  'catches-ball': 'Atrapa la pelota',
  'first-laugh': 'Primera risa',
  'first-babble': 'Primeros balbuceos',
  'says-mama-dada': 'Primer "mamá" o "papá"',
  'first-word': 'Primera palabra',
  'first-sentence': 'Primera frase',
  'says-own-name': 'Dice su nombre',
  'first-question': 'Primera pregunta',
  'first-joke': 'Primer chiste',
  'counts-to-ten': 'Cuenta hasta diez',
  'knows-alphabet': 'Se sabe el abecedario',
  'second-language-word': 'Primera palabra en otro idioma',
  'sings-song': 'Canta una canción entera',
  'first-solid-food': 'Primera comida sólida',
  'feeds-self': 'Come sin ayuda',
  'drinks-from-cup': 'Bebe de un vaso',
  'uses-fork-spoon': 'Usa cuchara y tenedor',
  'last-bottle': 'Adiós al biberón',
  'tries-notable-food': 'Prueba algo nuevo',
  'sleeps-through-night': 'Duerme toda la noche',
  'own-room': 'Primera noche en su cuarto',
  'big-kid-bed': 'Cama de grande',
  'first-tooth': 'Primer diente',
  'loses-first-tooth': 'Se le cae el primer diente',
  'first-tooth-fairy': 'Primera visita del Ratón Pérez',
  'potty-trained': 'Adiós al pañal',
  'dresses-self': 'Se viste sin ayuda',
  'brushes-teeth-self': 'Se cepilla los dientes',
  'ties-shoelaces': 'Se amarra los zapatos',
  'first-chore': 'Primera tarea en casa',
  'stays-with-sitter': 'Primera vez con niñera',
  'waves-bye': 'Dice adiós con la mano',
  'blows-kiss': 'Tira besos',
  'first-friend': 'Primera amistad',
  'says-i-love-you': 'Primer "te quiero"',
  'meets-sibling': 'Conoce a su hermano',
  'meets-grandparents': 'Conoce a sus abuelos',
  'first-day-daycare': 'Primer día de guardería',
  'first-day-preschool': 'Primer día de preescolar',
  'first-day-school': 'Primer día de colegio',
  'writes-name': 'Escribe su nombre',
  'first-drawing': 'Primer dibujo',
  'learns-to-read': 'Lee su primera palabra',
  'graduation': 'Graduación',
  'first-medal': 'Primera medalla',
  'first-bath': 'Primer baño',
  'first-haircut': 'Primer corte de pelo',
  'first-beach': 'Primera vez en la playa',
  'first-pool': 'Primera vez en la piscina',
  'first-snow': 'Primera nevada',
  'first-rain-play': 'Jugando bajo la lluvia',
  'first-plane': 'Primer vuelo',
  'first-trip': 'Primer viaje',
  'first-abroad': 'Primera vez en otro país',
  'first-camping': 'Primera acampada',
  'first-sleepover': 'Primera pijamada',
  'first-pet': 'Conoce a su mascota',
  'birthday': 'Cumpleaños',
  'first-holiday-season': 'Primeras fiestas',
  'first-halloween': 'Primer Halloween',
  'first-dentist': 'Primera visita al dentista',
};

export function topicTitle(topicId: string, language: FilmLanguage): string | null {
  const topic = getTopicById(topicId);
  if (!topic) return null;
  return language === 'es' ? TOPIC_TITLES_ES[topicId] ?? topic.pageTitle : topic.pageTitle;
}

export function milestoneLabel(milestoneId: string, language: FilmLanguage): string | null {
  const def = getMilestoneById(milestoneId);
  if (!def) return null;
  if (language === 'es') return MILESTONE_NAMES_ES[milestoneId] ?? null;
  // Catalog names may carry notes in parentheses ("Birthday (every year…)").
  return def.name.replace(/\s*\(.*\)\s*$/, '');
}

// ── Journal language ─────────────────────────────────────────────────────

const ES_WORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'con', 'por', 'para', 'se', 'su', 'sus',
  'es', 'muy', 'hoy', 'mi', 'le', 'lo', 'al', 'cuando', 'pero', 'mami', 'papi', 'dijo', 'estaba', 'fuimos',
]);
const EN_WORDS = new Set([
  'the', 'and', 'to', 'of', 'in', 'a', 'is', 'was', 'with', 'my', 'he', 'she', 'we', 'it', 'on', 'for', 'at',
  'his', 'her', 'today', 'said', 'very', 'our', 'went', 'mom', 'dad', 'when', 'but',
]);

/** The language most memories are written in, or null when there's too
 * little text to tell. A memory votes for the language with more
 * function-word hits in it. */
export function detectJournalLanguage(texts: (string | null)[]): FilmLanguage | null {
  let es = 0;
  let en = 0;
  for (const text of texts) {
    if (!text) continue;
    const words = text.toLowerCase().normalize('NFC').split(/[^\p{L}]+/u).filter(Boolean);
    let esHits = 0;
    let enHits = 0;
    for (const word of words) {
      if (ES_WORDS.has(word)) esHits += 1;
      if (EN_WORDS.has(word)) enHits += 1;
    }
    if (esHits + enHits < 2) continue;
    if (esHits > enHits) es += 1;
    else if (enHits > esHits) en += 1;
  }
  if (es + en < 5) return null;
  return es >= en ? 'es' : 'en';
}

/** The printed book's precedence: the journal's own language (model-reported
 * or detected), then the family setting, then English. */
export function resolveFilmLanguage(
  modelLanguage: string | null,
  detected: FilmLanguage | null,
  configured: string | null,
): FilmLanguage {
  const asFilm = (code: string | null): FilmLanguage | null =>
    code?.toLowerCase().startsWith('es') ? 'es' : code?.toLowerCase().startsWith('en') ? 'en' : null;
  return asFilm(modelLanguage) ?? detected ?? asFilm(configured) ?? 'en';
}
