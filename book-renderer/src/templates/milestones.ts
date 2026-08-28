import type { Language } from './furniture';

/**
 * Translated display names for every milestone catalog id (owner decision,
 * visual-review round 2 — "firsts pages must never mix languages"). Hand-
 * translated from `supabase/functions/_shared/memory-milestones.ts`'s 77
 * entries + `birthday`; keep this list in sync by eye whenever that catalog
 * changes (book-renderer is an isolated package and does not import from
 * supabase/, per docs/plans/memory-book.md Stage C, so this cannot be a
 * generated/shared import — only a hand-kept mirror).
 *
 * The manifest's own `milestone.name` field is always English (the DB
 * catalog's `name`) and is never printed directly for display — it's kept
 * only as a last-resort fallback for an id this table doesn't recognize yet
 * (future catalog growth outpacing this file), which is the one situation
 * where a page could show an English name inside an "es" book.
 */

const NAMES: Record<string, { es: string; en: string }> = {
  // Body & movement
  'first-smile': { es: 'Primera sonrisa', en: 'First smile' },
  'holds-head-up': { es: 'Sostiene la cabeza', en: 'Holds head up' },
  'rolls-over': { es: 'Se voltea', en: 'Rolls over' },
  'sits-up': { es: 'Se sienta sin ayuda', en: 'Sits up unassisted' },
  crawling: { es: 'Empieza a gatear', en: 'Starts crawling' },
  'pulls-to-stand': { es: 'Se para solo', en: 'Pulls up to stand' },
  'first-steps': { es: 'Primeros pasos', en: 'First steps' },
  walking: { es: 'Camina con confianza', en: 'Walking confidently' },
  climbing: { es: 'Primera vez que trepa', en: 'First climbing' },
  running: { es: 'Empieza a correr', en: 'Starts running' },
  'first-jump': { es: 'Primer salto (con los dos pies)', en: 'First jump (two feet)' },
  'balance-bike': { es: 'Monta bicicleta sin pedales', en: 'Rides scooter / balance bike' },
  'bike-training-wheels': { es: 'Monta bicicleta con rueditas', en: 'Rides bike with training wheels' },
  'bike-no-training-wheels': { es: 'Monta bicicleta sin rueditas', en: 'Rides bike without training wheels' },
  'swims-unassisted': { es: 'Nada sin ayuda', en: 'Swims without help' },
  'first-somersault': { es: 'Primera voltereta / maroma', en: 'First somersault / cartwheel' },
  'catches-ball': { es: 'Atrapa una pelota', en: 'Catches a ball' },

  // Talking & language
  'first-laugh': { es: 'Primera risa', en: 'First laugh' },
  'first-babble': { es: 'Primer balbuceo', en: 'First babbling' },
  'says-mama-dada': { es: "Primer 'mamá'/'papá'", en: 'First "mama"/"dada"' },
  'first-word': { es: 'Primera palabra', en: 'First word' },
  'first-sentence': { es: 'Primera oración / frase de dos palabras', en: 'First sentence / two-word phrase' },
  'says-own-name': { es: 'Dice su propio nombre', en: 'Says own name' },
  'first-question': { es: 'Primera pregunta', en: 'First question asked' },
  'first-joke': { es: 'Primer chiste / travesura a propósito', en: 'First joke / deliberate silliness' },
  'counts-to-ten': { es: 'Cuenta hasta diez', en: 'Counts to ten' },
  'knows-alphabet': { es: 'Se sabe el abecedario', en: 'Knows the alphabet' },
  'second-language-word': { es: 'Primera palabra en un segundo idioma', en: 'First word in second language' },
  'sings-song': { es: 'Canta una canción completa', en: 'Sings a whole song' },

  // Eating
  'first-solid-food': { es: 'Primera comida sólida', en: 'First solid food' },
  'feeds-self': { es: 'Come solo con las manos o la cuchara', en: 'Feeds self with hands/spoon' },
  'drinks-from-cup': { es: 'Toma de un vaso', en: 'Drinks from a cup' },
  'uses-fork-spoon': { es: 'Usa el tenedor y la cuchara bien', en: 'Uses fork/spoon properly' },
  'last-bottle': { es: 'Último biberón / deja el pecho', en: 'Weaning / last bottle or nursing' },
  'tries-notable-food': { es: 'Comida memorable por primera vez', en: 'Memorable first food' },

  // Sleep & growing up
  'sleeps-through-night': { es: 'Duerme toda la noche', en: 'Sleeps through the night' },
  'own-room': { es: 'Primera noche en su propio cuarto', en: 'First night in own room' },
  'big-kid-bed': { es: 'Pasa a la cama de niño grande', en: 'Moves to big-kid bed' },
  'first-tooth': { es: 'Primer diente', en: 'First tooth' },
  'loses-first-tooth': { es: 'Pierde su primer diente', en: 'Loses first tooth' },

  // Self-care & independence
  'potty-trained': { es: 'Deja el pañal', en: 'Potty trained / diaper-free' },
  'dresses-self': { es: 'Se viste solo', en: 'Dresses themselves' },
  'brushes-teeth-self': { es: 'Se cepilla los dientes solo', en: 'Brushes own teeth' },
  'ties-shoelaces': { es: 'Amarra sus cordones', en: 'Ties shoelaces' },
  'first-chore': { es: 'Primera tarea del hogar', en: 'First chore / helping task' },
  'stays-with-sitter': { es: 'Primera vez con niñera', en: 'First time with babysitter' },

  // Social & emotional
  'waves-bye': { es: 'Dice adiós con la mano', en: 'Waves bye-bye' },
  'blows-kiss': { es: 'Manda un beso', en: 'Blows a kiss' },
  'first-friend': { es: 'Primer amigo', en: 'First friend' },
  'says-i-love-you': { es: "Primer 'te quiero'", en: 'First "I love you"' },
  'meets-sibling': { es: 'Conoce a su hermano/a', en: 'Meets sibling for the first time' },
  'meets-grandparents': { es: 'Conoce a sus abuelos', en: 'Meets grandparent for the first time' },

  // School & learning
  'first-day-daycare': { es: 'Primer día de guardería', en: 'First day of daycare/nursery' },
  'first-day-preschool': { es: 'Primer día de preescolar', en: 'First day of preschool' },
  'first-day-school': { es: 'Primer día de escuela', en: 'First day of school' },
  'writes-name': { es: 'Escribe su nombre', en: 'Writes own name' },
  'first-drawing': { es: 'Primer dibujo reconocible', en: 'First recognizable drawing' },
  'learns-to-read': { es: 'Lee su primera palabra o libro', en: 'Reads first word/book' },
  graduation: { es: 'Graduación de preescolar/kínder', en: 'Preschool/kinder graduation' },
  'first-medal': { es: 'Primera medalla / trofeo / premio', en: 'First medal / trophy / prize' },

  // Firsts & experiences
  'first-bath': { es: 'Primer baño', en: 'First bath' },
  'first-haircut': { es: 'Primer corte de pelo', en: 'First haircut' },
  'first-beach': { es: 'Primera vez en la playa', en: 'First time at the beach' },
  'first-pool': { es: 'Primera vez nadando / en la piscina', en: 'First swim / pool visit' },
  'first-snow': { es: 'Primera nieve', en: 'First snow' },
  'first-rain-play': { es: 'Primera vez jugando en la lluvia', en: 'First time playing in the rain' },
  'first-plane': { es: 'Primer vuelo en avión', en: 'First plane flight' },
  'first-trip': { es: 'Primer viaje / vacaciones', en: 'First trip / vacation' },
  'first-abroad': { es: 'Primera vez fuera del país', en: 'First time abroad' },
  'first-camping': { es: 'Primer campamento', en: 'First camping trip' },
  'first-sleepover': { es: 'Primera vez durmiendo fuera de casa', en: 'First sleepover away from parents' },
  'first-pet': { es: 'Conoce a la primera mascota de la familia', en: 'Meets first family pet' },
  birthday: { es: 'Cumpleaños', en: 'Birthday' },
  'first-holiday-season': { es: 'Primera Navidad / Janucá / fiesta de fin de año', en: 'First Christmas / Hanukkah / holiday' },
  'first-halloween': { es: 'Primer Halloween / disfraz', en: 'First Halloween / costume' },
  'first-tooth-fairy': { es: 'Primera visita del ratoncito Pérez', en: 'First tooth-fairy visit' },
  'first-dentist': { es: 'Primera visita al dentista', en: 'First dentist visit' },
};

export const MILESTONE_IDS: readonly string[] = Object.keys(NAMES);

/**
 * The Firsts-page display name for a milestone: looks up `id` in the
 * translated table; `detail` (e.g. the age turned) is folded into the
 * birthday entry specifically. Falls back to the manifest's own raw
 * `fallbackName` only for an id this table doesn't recognize.
 */
export function getMilestoneName(id: string, detail: string | null, lang: Language, fallbackName: string): string {
  const entry = NAMES[id];
  if (!entry) return fallbackName;
  const name = entry[lang];
  if (id === 'birthday' && detail) {
    return lang === 'es' ? `${name} (cumple ${detail} años)` : `${name} (turns ${detail})`;
  }
  return name;
}
