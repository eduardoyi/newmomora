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

/** Themes as things the child (or family) loved to do — the burst titles
 * sit under "Lo que más te gustó este año" / "What you loved this year"
 * (owner, F3: bare topic titles read like random phrases). `{te}` is the
 * reflexive pronoun of the film's voice: "te" (parent to child) or "nos"
 * (family). `null`: not something a film should call loved (hard days,
 * check-ups, newborn care…) — that topic never becomes a theme. */
const TOPIC_ACTIVITIES: Readonly<Record<FilmLanguage, Readonly<Record<string, string | null>>>> = {
  es: {
    'beach': 'ir a la playa',
    'lake-river': 'jugar junto al agua',
    'pool-water': 'chapotear en el agua',
    'snow-play': 'jugar en la nieve',
    'mountains-hiking': 'subir a la montaña',
    'outdoors-nature': 'explorar la naturaleza',
    'countryside-farm': 'visitar el campo',
    'camping': 'dormir bajo las estrellas',
    'park-playground': 'ir al parque',
    'days-out': 'salir de excursión',
    'out-and-about': 'salir de paseo',
    'travel': 'viajar lejos de casa',
    'eating-out': 'comer fuera',
    'mealtime': 'comer en familia',
    'cooking-baking': 'cocinar juntos',
    'treats': 'comer algo dulce',
    'bath': null,
    'bedtime-sleep': null,
    'mornings': null,
    'baby-care': null,
    'helping-chores': 'ayudar en casa',
    'tough-days': null,
    'doctor-dentist': null,
    'moving-new-home': 'estrenar casa nueva',
    'outfits-style': 'vestir{te} con estilo',
    'pretend-play': 'disfrazar{te} y jugar a imaginar',
    'arts-crafts': 'pintar y hacer manualidades',
    'sensory-messy-play': 'ensuciar{te} jugando',
    'toys-building': 'jugar con bloques y trenes',
    'books-reading': 'leer cuentos',
    'music-dance': 'cantar y bailar',
    'bikes-scooters': 'mover{te} sobre ruedas',
    'sports-exercise': 'correr y hacer deporte',
    'pregnancy-expecting': null,
    'newborn-days': null,
    'words-and-sayings': null,
    'big-kid-skills': 'aprender cosas nuevas',
    'grandparents': 'estar con los abuelos',
    'extended-family': 'ver a los tíos y primos',
    'friends': 'jugar con amigos',
    'animals-pets': 'estar con animales',
    'birthday': 'celebrar cumpleaños',
    'valentines': 'celebrar San Valentín',
    'mothers-fathers-day': 'celebrar a mamá y papá',
    'christmas': 'celebrar la Navidad',
    'new-year': 'recibir el Año Nuevo',
    'thanksgiving': 'celebrar Acción de Gracias',
    'halloween': 'disfrazar{te} en Halloween',
    'easter': 'celebrar la Pascua',
    'lunar-new-year': 'celebrar el Año Nuevo Lunar',
    'hanukkah': 'celebrar Janucá',
    'eid': 'celebrar el Eid',
    'diwali': 'celebrar Diwali',
    'dia-de-muertos': 'celebrar el Día de Muertos',
    'national-holiday': 'celebrar las fiestas',
    'other-holiday': 'ir a fiestas y festivales',
    'wedding': 'ir a una boda',
    'ceremony': null,
    'family-gathering': 'reunir{te} con toda la familia',
    'school': 'ir a la escuela',
    'faith-and-traditions': 'vivir nuestras tradiciones',
  },
  en: {
    'beach': 'going to the beach',
    'lake-river': 'playing by the water',
    'pool-water': 'splashing in the water',
    'snow-play': 'playing in the snow',
    'mountains-hiking': 'hiking in the mountains',
    'outdoors-nature': 'exploring outdoors',
    'countryside-farm': 'days in the countryside',
    'camping': 'sleeping under the stars',
    'park-playground': 'going to the park',
    'days-out': 'big days out',
    'out-and-about': 'going out and about',
    'travel': 'traveling far from home',
    'eating-out': 'eating out',
    'mealtime': 'family meals',
    'cooking-baking': 'cooking together',
    'treats': 'sweet treats',
    'bath': null,
    'bedtime-sleep': null,
    'mornings': null,
    'baby-care': null,
    'helping-chores': 'helping around the house',
    'tough-days': null,
    'doctor-dentist': null,
    'moving-new-home': 'making a new home',
    'outfits-style': 'dressing up in style',
    'pretend-play': 'dress-up and pretend play',
    'arts-crafts': 'arts and crafts',
    'sensory-messy-play': 'getting messy',
    'toys-building': 'building with blocks and trains',
    'books-reading': 'reading stories',
    'music-dance': 'singing and dancing',
    'bikes-scooters': 'riding on wheels',
    'sports-exercise': 'running and playing sports',
    'pregnancy-expecting': null,
    'newborn-days': null,
    'words-and-sayings': null,
    'big-kid-skills': 'learning new things',
    'grandparents': 'time with grandma and grandpa',
    'extended-family': 'time with aunts, uncles and cousins',
    'friends': 'playing with friends',
    'animals-pets': 'time with animals',
    'birthday': 'birthday parties',
    'valentines': "celebrating Valentine's Day",
    'mothers-fathers-day': 'celebrating mom and dad',
    'christmas': 'celebrating Christmas',
    'new-year': 'ringing in the New Year',
    'thanksgiving': 'Thanksgiving together',
    'halloween': 'dressing up for Halloween',
    'easter': 'celebrating Easter',
    'lunar-new-year': 'celebrating Lunar New Year',
    'hanukkah': 'celebrating Hanukkah',
    'eid': 'celebrating Eid',
    'diwali': 'celebrating Diwali',
    'dia-de-muertos': 'celebrating Día de Muertos',
    'national-holiday': 'national holidays',
    'other-holiday': 'festivals and holidays',
    'wedding': 'going to a wedding',
    'ceremony': null,
    'family-gathering': 'getting the whole family together',
    'school': 'going to school',
    'faith-and-traditions': 'our family traditions',
  },
};

/** A topic as an activity in the film's voice, or null when it shouldn't be
 * called loved (see TOPIC_ACTIVITIES). Unknown topics fall back to null. */
export function topicActivity(topicId: string, language: FilmLanguage, voice: 'child' | 'family' | 'third'): string | null {
  const phrase = TOPIC_ACTIVITIES[language][topicId];
  if (!phrase) return null;
  // 'third': about a child, to others ("disfrazarse y jugar a imaginar") —
  // the holiday letter's per-person profiles.
  return phrase.replaceAll('{te}', voice === 'child' ? 'te' : voice === 'third' ? 'se' : 'nos');
}

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

/** Plain-language phrasing of a first for the holiday card film (owner,
 * 2026-10-05: the firsts card said the catalog label "Camina con confianza"
 * where a parent says "Dio sus primeros pasos"). Past-tense, no subject (the
 * card names the child under it), no gendered words. Milestones without an
 * entry fall back to the catalog label. */
export const HOLIDAY_FIRST_PHRASES: Readonly<Record<FilmLanguage, Readonly<Record<string, string>>>> = {
  es: {
    'first-smile': 'Su primera sonrisa',
    'holds-head-up': 'Sostuvo la cabeza',
    'rolls-over': 'Se dio la vuelta',
    'sits-up': 'Se sentó sin ayuda',
    'crawling': 'Empezó a gatear',
    'pulls-to-stand': 'Se puso de pie',
    'first-steps': 'Dio sus primeros pasos',
    'walking': 'Dio sus primeros pasos',
    'climbing': 'Empezó a trepar',
    'running': 'Empezó a correr',
    'first-jump': 'Dio su primer salto',
    'balance-bike': 'Se subió a su primera bici sin pedales',
    'bike-training-wheels': 'Se subió a la bici con rueditas',
    'bike-no-training-wheels': 'Aprendió a ir en bici sin rueditas',
    'swims-unassisted': 'Aprendió a nadar sin ayuda',
    'first-somersault': 'Hizo su primera voltereta',
    'catches-ball': 'Atrapó la pelota',
    'first-laugh': 'Su primera risa',
    'first-babble': 'Empezó a balbucear',
    'says-mama-dada': 'Dijo "mamá" y "papá"',
    'first-word': 'Dijo su primera palabra',
    'first-sentence': 'Dijo su primera frase',
    'says-own-name': 'Dijo su nombre',
    'first-question': 'Hizo su primera pregunta',
    'first-joke': 'Contó su primer chiste',
    'counts-to-ten': 'Contó hasta diez',
    'knows-alphabet': 'Se aprendió el abecedario',
    'second-language-word': 'Dijo su primera palabra en otro idioma',
    'sings-song': 'Cantó una canción entera',
    'first-solid-food': 'Probó su primera comida sólida',
    'feeds-self': 'Comió sin ayuda',
    'drinks-from-cup': 'Bebió de un vaso',
    'uses-fork-spoon': 'Usó cuchara y tenedor',
    'tries-notable-food': 'Probó algo nuevo',
    'sleeps-through-night': 'Durmió toda la noche',
    'own-room': 'Durmió su primera noche en su cuarto',
    'big-kid-bed': 'Pasó a su cama de grande',
    'first-tooth': 'Le salió el primer diente',
    'loses-first-tooth': 'Se le cayó el primer diente',
    'first-tooth-fairy': 'Recibió la visita del Ratón Pérez',
    'dresses-self': 'Se vistió sin ayuda',
    'brushes-teeth-self': 'Se cepilló los dientes solo',
    'ties-shoelaces': 'Se amarró los zapatos',
    'first-chore': 'Ayudó por primera vez en casa',
    'stays-with-sitter': 'Se quedó con una niñera',
    'waves-bye': 'Dijo adiós con la mano',
    'blows-kiss': 'Mandó su primer beso',
    'first-friend': 'Hizo su primer amigo',
    'says-i-love-you': 'Dijo su primer "te quiero"',
    'meets-sibling': 'Conoció a su hermano',
    'meets-grandparents': 'Conoció a sus abuelos',
    'first-day-daycare': 'Su primer día de guardería',
    'first-day-preschool': 'Su primer día de preescolar',
    'first-day-school': 'Su primer día de colegio',
    'writes-name': 'Escribió su nombre',
    'first-drawing': 'Hizo su primer dibujo',
    'learns-to-read': 'Leyó su primera palabra',
    'graduation': 'Se graduó',
    'first-medal': 'Ganó su primera medalla',
    'first-haircut': 'Se cortó el pelo por primera vez',
    'first-beach': 'Conoció la playa',
    'first-pool': 'Se metió en la piscina por primera vez',
    'first-snow': 'Vio la nieve por primera vez',
    'first-rain-play': 'Jugó bajo la lluvia',
    'first-plane': 'Voló por primera vez',
    'first-trip': 'Hizo su primer viaje',
    'first-abroad': 'Viajó a otro país por primera vez',
    'first-camping': 'Se fue de acampada por primera vez',
    'first-sleepover': 'Se quedó a dormir fuera por primera vez',
    'first-pet': 'Conoció a su mascota',
    'first-holiday-season': 'Vivió sus primeras fiestas',
    'first-halloween': 'Celebró su primer Halloween',
  },
  en: {
    'first-smile': 'First smile',
    'holds-head-up': 'Held their head up',
    'rolls-over': 'Rolled over',
    'sits-up': 'Sat up on their own',
    'crawling': 'Started crawling',
    'pulls-to-stand': 'Pulled up to stand',
    'first-steps': 'Took their first steps',
    'walking': 'Took their first steps',
    'climbing': 'Started climbing',
    'running': 'Started running',
    'first-jump': 'Made their first jump',
    'balance-bike': 'Hopped on a balance bike',
    'bike-training-wheels': 'Rode a bike with training wheels',
    'bike-no-training-wheels': 'Learned to ride without training wheels',
    'swims-unassisted': 'Learned to swim on their own',
    'first-somersault': 'Did their first somersault',
    'catches-ball': 'Caught the ball',
    'first-laugh': 'First laugh',
    'first-babble': 'Started babbling',
    'says-mama-dada': 'Said "mama" and "dada"',
    'first-word': 'Said their first word',
    'first-sentence': 'Said their first sentence',
    'says-own-name': 'Said their own name',
    'first-question': 'Asked their first question',
    'first-joke': 'Told their first joke',
    'counts-to-ten': 'Counted to ten',
    'knows-alphabet': 'Learned the alphabet',
    'second-language-word': 'Said a first word in another language',
    'sings-song': 'Sang a whole song',
    'first-solid-food': 'Tried their first solid food',
    'feeds-self': 'Fed themselves',
    'drinks-from-cup': 'Drank from a cup',
    'uses-fork-spoon': 'Used a fork and spoon',
    'tries-notable-food': 'Tried something new',
    'sleeps-through-night': 'Slept through the night',
    'own-room': 'Spent a first night in their own room',
    'big-kid-bed': 'Moved to a big-kid bed',
    'first-tooth': 'Got their first tooth',
    'loses-first-tooth': 'Lost their first tooth',
    'first-tooth-fairy': 'Got a visit from the tooth fairy',
    'dresses-self': 'Got dressed on their own',
    'brushes-teeth-self': 'Brushed their own teeth',
    'ties-shoelaces': 'Tied their own shoes',
    'first-chore': 'Helped around the house',
    'stays-with-sitter': 'Stayed with a babysitter',
    'waves-bye': 'Waved bye-bye',
    'blows-kiss': 'Blew a first kiss',
    'first-friend': 'Made a first friend',
    'says-i-love-you': 'Said their first "I love you"',
    'meets-sibling': 'Met their sibling',
    'meets-grandparents': 'Met their grandparents',
    'first-day-daycare': 'First day of daycare',
    'first-day-preschool': 'First day of preschool',
    'first-day-school': 'First day of school',
    'writes-name': 'Wrote their own name',
    'first-drawing': 'Made their first drawing',
    'learns-to-read': 'Read their first word',
    'graduation': 'Graduated',
    'first-medal': 'Won a first medal',
    'first-haircut': 'Had a first haircut',
    'first-beach': 'First time at the beach',
    'first-pool': 'First swim in the pool',
    'first-snow': 'Saw snow for the first time',
    'first-rain-play': 'Played in the rain',
    'first-plane': 'Took a first flight',
    'first-trip': 'Went on a first trip',
    'first-abroad': 'Traveled abroad for the first time',
    'first-camping': 'Went camping for the first time',
    'first-sleepover': 'Had a first sleepover',
    'first-pet': 'Met the family pet',
    'first-holiday-season': 'Celebrated a first holiday season',
    'first-halloween': 'Celebrated a first Halloween',
  },
};

/** The holiday film's phrasing of a first, else the catalog label. */
export function holidayFirstLabel(milestoneId: string, language: FilmLanguage): string | null {
  return HOLIDAY_FIRST_PHRASES[language][milestoneId] ?? milestoneLabel(milestoneId, language);
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
