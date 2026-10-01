// Explicit-evidence gate for milestone claims (owner rule, 2026-10-01):
// NEVER assume or infer a milestone unless the parent's own text explicitly
// states it. docs/plans/milestone-catalog.md principle 1 always said so; the
// detector did not enforce it (a haircut caption tagged `first-haircut`, a
// question tagged `first-question`, a balance-bike ride tagged
// `balance-bike` with no "first"/"learned" wording -- only ~1 in 5 tagged
// "firsts" on the owner's books had first-time language).
//
// This module is the DETERMINISTIC, code-side half of the fix (the prompt
// half lives in analyze-memory-core.ts). It is pure (no I/O, no model) and is
// shared by:
//   1. analyze-memory-core.ts -- gates the model's milestone claim against
//      the model's verbatim `evidence` quote and the memory text.
//   2. supabase/scripts/milestone-honesty-backfill.ts -- applies the same
//      rules to the memory text of already-stored candidate rows (which have
//      no stored evidence quote).
//
// A claim is KEPT only when ALL of these hold:
//   a. the evidence quote is a verbatim substring of the memory text
//      (case / diacritics / whitespace / punctuation insensitive);
//   b. the quote carries explicit language the entry's `kind` requires
//      (first-time language for inherently-"first X" entries; first-time OR
//      achievement language for achievement entries; the event phrase itself
//      for event entries -- see MilestoneEvidenceRule);
//   c. the quote is about the milestone (the entry's `subject` stems, es/en/pt)
//      -- first-time wording about something else does not count.
//
// Nothing here ever looks at photos, dates, ages, or topics. Languages: es,
// en, pt (the journal languages). Matching is on a folded form: lowercase,
// diacritics stripped, every non-alphanumeric run collapsed to one space.
// Rule sources below are written against that folded form (so hyphens and
// apostrophes appear as spaces, e.g. `pre\s?k`, `kid\ss`).
import { MILESTONES } from './memory-milestones.ts';

export type MilestoneEvidenceKind =
  /** Inherently "first X" entries (first-haircut, first-question, ...): the
   * quote must say it is the FIRST time. That X merely happened is not
   * enough. */
  | 'first'
  /** Skill / state entries (rolls-over, balance-bike, ties-shoelaces, ...):
   * the quote must say it is the first time OR state the achievement
   * (learned to / aprendió a / ya sabe / finally / sin ayuda ...). */
  | 'achievement'
  /** Entries whose milestone IS the event (birthday, graduation): the quote
   * must state the event itself (`phrases`). */
  | 'event';

export interface MilestoneEvidenceRule {
  readonly kind: MilestoneEvidenceKind;
  /** Stems (regex source, folded form) the quote must mention for the
   * claim to be about THIS milestone. Omitted for `event` entries. */
  readonly subject?: string;
  /** Complete standalone statements of the milestone (regex source). A quote
   * matching one of these passes without first/achievement words and
   * without the subject check (the phrase names the milestone itself). */
  readonly phrases?: string;
  /** Extra achievement-like wording specific to this entry (regex source);
   * still subject-gated. Used by meets-* ("conoció a", "met"). */
  readonly extra?: string;
}

const R = (
  kind: MilestoneEvidenceKind,
  subject?: string,
  opts: { phrases?: string; extra?: string } = {},
): MilestoneEvidenceRule => ({ kind, subject, ...opts });

const MEET_WORDS = 'meet|meets|meeting|met|conoc\\w*|conhec\\w*|presentad\\w*|introduc\\w*';

/**
 * Per-catalog-entry rules. One entry per id in memory-milestones.ts (a test
 * enforces exact coverage both ways). When adding a milestone to the catalog,
 * add its rule here in the same change.
 */
export const MILESTONE_EVIDENCE_RULES: Readonly<Record<string, MilestoneEvidenceRule>> = {
  // ── Body & movement ──────────────────────────────────────────────────
  'first-smile': R('first', 'smil|sonri|sorri|sonreir'),
  'holds-head-up': R('achievement', 'head|cabeza|cabeca|cuello|neck'),
  'rolls-over': R('achievement', 'roll|volte|vuelta|virou|virar|girar|gir[oa](?![a-z])'),
  'sits-up': R('achievement', 'sit(?![a-z])|sits|sitting|sat(?![a-z])|sent[ao]|sienta|sentad|sentou|sentar'),
  crawling: R('achievement', 'crawl|gatea|gateo|arrastr|engatinh|reptar'),
  'pulls-to-stand': R('achievement', 'stand|stood|de\\spie|parar|levant|em\\spe(?![a-z])|pull'),
  'first-steps': R('first', 'step|paso|passo|walk|camin|anda(?![a-z])|andar|andu'),
  walking: R('achievement', 'walk|camin|anda(?![a-z])|andar|andu'),
  climbing: R('achievement', 'climb|escal|trep|subi|sube|subir|subiu'),
  running: R('achievement', 'run(?![a-z])|runs|running|ran(?![a-z])|corr'),
  'first-jump': R('achievement', 'jump|salt|pulo|pulou|pular'),
  'balance-bike': R('achievement', 'bike|bici|scooter|patin|monopat|balance|equilibri|trotinet|correpasillos'),
  'bike-training-wheels': R('achievement', 'bike|bici|training\\swheels|ruedas|rodinhas|pedal'),
  'bike-no-training-wheels': R('achievement', 'bike|bici|wheels|ruedas|rodinhas|pedal', {
    phrases:
      '(?:without|no|no\\smore|off)\\straining\\swheels|sin\\s(?:las\\s)?ruedas|sem\\s(?:as\\s)?rodinhas|sin\\sruedines|quito\\slas\\sruedas|tirou\\sas\\srodinhas',
  }),
  'swims-unassisted': R('achievement', 'swim|swam|nadar|nadando|nadaba|nado(?![a-z])|nade(?![a-z])|nadou|nadas|nada\\s(?:sozinh|sem|bem|muito|longe)'),
  'first-somersault': R('first', 'somersault|cartwheel|voltereta|maroma|pirueta|cambalhota|rueda|flip'),
  'catches-ball': R('achievement', 'catch|caught|atrap|agarr|apanh|pegou'),

  // ── Talking & language ───────────────────────────────────────────────
  'first-laugh': R('first', 'laugh|giggl|risa|risita|carcaj|risad|gargalh|reir|riu(?![a-z])|se\\srio|se\\srie'),
  'first-babble': R('achievement', 'babbl|balbuce|balbuci|parlote|gorje|gorgue|mamama|dadada|lalala|gugu'),
  'says-mama-dada': R(
    'achievement',
    'mama|mami|mommy|mom(?![a-z])|dada|papa|papi|daddy|dad(?![a-z])|mae(?![a-z])|pai(?![a-z])|mamae|papai',
  ),
  'first-word': R('first', 'word|palabra|palavra|habl|dijo|said|say(?![a-z])|dice|decir|disse|talk|fal'),
  'first-sentence': R('achievement', 'sentence|phrase|frase|oracion|words|palabras|palavras|junt', {
    phrases:
      'two\\sword|put\\stwo\\swords\\stogether|junt\\w*\\sdos\\spalabras|junt\\w*\\sduas\\spalavras|dos\\spalabras\\sjuntas',
  }),
  'says-own-name': R('achievement', 'name|nombre|nome|llam|chama'),
  'first-question': R('first', 'question|pregunt|pergunt|why(?![a-z])|por\\sque|asked|ask(?![a-z])'),
  'first-joke': R('first', 'joke|chiste|broma|piada|bromea|joking|funny|gracios|silly|payas|travess|brincad'),
  'counts-to-ten': R(
    'achievement',
    'count|cont(?:ar|ando|aba|o|ou)(?![a-z])|diez|ten(?![a-z])|dez(?![a-z])|10(?![a-z0-9])|numer',
  ),
  'knows-alphabet': R('achievement', 'alphabet|abecedario|alfabeto|abc(?![a-z])|letras|letters'),
  'second-language-word': R(
    'first',
    'english|ingles|spanish|espanol|portugu|french|frances|german|aleman|italian|language|idioma|lengua|lingua|bilingu|word|palabra|palavra',
  ),
  'sings-song': R('achievement', 'sing|sang|sung|cant|song|cancion|cancao'),

  // ── Eating ───────────────────────────────────────────────────────────
  'first-solid-food': R(
    'first',
    'solid|food|comid|comer|comio|comi(?![a-z])|papilla|papinha|puree|pure(?![a-z])|cereal|eat|ate(?![a-z])|taste|prob|aliment|bite|bocado|mordi|fruta|fruit',
  ),
  'feeds-self': R(
    'achievement',
    'feed|fed(?![a-z])|ate(?![a-z])|eat|com[ei](?![a-z])|comio|comer|comeu|spoon|cuchar|colher|aliment',
  ),
  'drinks-from-cup': R('achievement', 'cup|vaso|taza|copo|xicara|drank|drink|beb[eio]'),
  'uses-fork-spoon': R('achievement', 'fork|spoon|tenedor|cuchar|garfo|colher|cubierto|cutlery|talher'),
  'last-bottle': R('achievement', 'bottle|biber|mamader|mamila|teta|nurs|breast|pecho|lactanc|amamant|mamadeira|peito', {
    phrases:
      'last\\s(?:bottle|feed(?:ing)?|nurs\\w*|time\\s(?:nurs\\w*|breast\\w*|bottle))|ultim[oa]\\s(?:biber\\w*|toma|teta|vez\\s(?:que\\s)?(?:tom|amamant|mam)\\w*|mamad\\w*)|weaned|weaning|destet\\w*|desmam\\w*|bye\\sbye\\sbottle|adios\\s(?:al\\s)?biber\\w*|no\\smore\\s(?:bottle|nursing)',
  }),
  'tries-notable-food': R(
    'first',
    'try(?![a-z])|tried|tries|trying|tast|prob|prov|food|comid|eat|ate(?![a-z])|comer|comio|saboreo|experiment',
  ),

  // ── Sleep & growing up ───────────────────────────────────────────────
  'sleeps-through-night': R('achievement', 'sleep|slept|dorm|durm|noche|night|noite', {
    phrases:
      '(?:slept|sleep|sleeps|sleeping)\\sthrough\\sthe\\snight|durmi\\w*\\s(?:toda\\sla\\snoche|de\\scorrido)|dorm\\w*\\s(?:toda\\sla\\snoche|a\\snoite\\stoda|toda\\sa\\snoite)|toda\\sla\\snoche\\s(?:de\\scorrido|sin\\sdespertar)',
  }),
  'own-room': R('achievement', 'room|cuarto|habitacion|pieza|quarto|recamara|alcoba|bedroom|propia|propio|own(?![a-z])'),
  'big-kid-bed': R('achievement', 'bed(?![a-z])|cama|crib|cuna|toddler|cot(?![a-z])|berco', {
    phrases:
      'big\\s(?:kid|boy|girl)(?:\\ss)?s?\\sbed|cama\\s(?:grande|de\\s(?:grande|nino|nina|mayor|gente\\sgrande|menino|menina))',
  }),
  'first-tooth': R('first', 'tooth|teeth|dient|dente|dentinho|colmill'),
  'loses-first-tooth': R('first', 'tooth|teeth|dient|dente|dentinho|colmill'),

  // ── Self-care & independence ─────────────────────────────────────────
  'potty-trained': R('achievement', 'potty|diaper|nappy|nappies|panal|fralda|orinal|inodoro|toilet|bano|banheiro|pipi|retrete|penico|vasinho|train', {
    phrases:
      'potty\\s?train\\w*|toilet\\s?train\\w*|diaper\\s?free|no\\smore\\s(?:diapers|nappies)|no\\slonger\\s(?:in|wears?|needs?|uses?)\\s(?:diapers|nappies)|sin\\spanal(?:es)?|sem\\sfralda|ya\\sno\\s(?:usa|necesita|lleva|tiene)\\spanal|dejo\\s(?:el|los)\\spanal(?:es)?|adios\\s(?:al\\s)?panal|nao\\susa\\sfralda|tirou\\s(?:a\\s)?fralda|desfralde',
  }),
  'dresses-self': R('achievement', 'dress|cloth|vest|ropa|roupa|shirt|pants|trousers|shoes'),
  'brushes-teeth-self': R('achievement', 'brush|teeth|tooth|cepill|dient|escov|dente'),
  'ties-shoelaces': R('achievement', 'shoelace|laces|tied|tie(?![a-z])|ties(?![a-z])|cordon|agujeta|atar|amarr|cadarc|shoes|zapat|sapat'),
  'first-chore': R(
    'first',
    'chore|help|ayud|ajud|table|mesa|tarea|quehacer|barr|sweep|clean|limpi|laund|dish|platos|lav[ao]|cook|cocin|regar|trash|basura|lixo|tidy|ordena|recog|colabor|tarefa',
  ),
  'stays-with-sitter': R('first', 'sitter|babysit|nanny|ninera|baba(?![a-z])|cuidador|canguro|night\\sout|noche\\s(?:fuera|de\\spareja|libre)|saida'),

  // ── Social & emotional ───────────────────────────────────────────────
  'waves-bye': R('achievement', 'wav(?:e|ed|es|ing)(?![a-z])|bye|adios|chao|tchau|despid|salud|acen'),
  'blows-kiss': R('achievement', 'kiss|beso|besito|beij|blew|blow'),
  'first-friend': R('first', 'friend|amig|amigu'),
  'says-i-love-you': R('first', 'love|quiero|amo(?![a-z])|amor|te\\squero|adoro'),
  'meets-sibling': R('achievement', 'brother|sister|sibling|hermano|hermana|hermanit|irma|baby|bebe|newborn|recien\\snacid|recem\\snascid', {
    extra: MEET_WORDS,
  }),
  'meets-grandparents': R('achievement', 'grand(?:ma|pa|mother|father|parent)|abuel|avo(?![a-z])|avos|vovo|nono|nona|yaya|oma(?![a-z])|opa(?![a-z])', {
    extra: MEET_WORDS,
  }),

  // ── School & learning ────────────────────────────────────────────────
  'first-day-daycare': R('first', 'daycare|day\\scare|nursery|guarder|creche|jardin|childcare|escuelita|maternal'),
  'first-day-preschool': R(
    'first',
    'preschool|pre\\s?k(?![a-z])|pre\\sschool|prescolar|preescolar|kinder|jardin|infantil|maternal|escuelita|escolinha|pre\\s?escola',
  ),
  'first-day-school': R(
    'first',
    'school|escuela|cole(?![a-z])|colegio|escola|class|clase|aula|kinder|primaria|grade|grado|teacher|maestr|profe',
  ),
  'writes-name': R('achievement', 'wrote|write|writes|writing|escrib|escrev|escrit|spell|deletre'),
  'first-drawing': R('first', 'draw|drew|dibuj|desenh|pinto|pinta|paint|scribbl|garabat|rabisc'),
  'learns-to-read': R('achievement', 'read|lee(?![a-z])|leer|leyo|leyendo|lectur|ler(?![a-z])|leu(?![a-z])|lendo'),
  graduation: {
    kind: 'event',
    phrases: 'graduat\\w*|graduaci\\w*|graduad\\w*|formatura|diploma|egres\\w*|cap\\sand\\sgown|toga|birrete',
  },
  'first-medal': R('first', 'medal|trophy|trofe|prize|premio|award|ribbon|won(?![a-z])|win(?![a-z])|gano|gana(?![a-z])|ganar|ganhou|certificad|certificate'),

  // ── Firsts & experiences ─────────────────────────────────────────────
  'first-bath': R('first', 'bath|bano|banar|banera|banho|banheira|tina(?![a-z])'),
  'first-haircut': R(
    'first',
    'hair|haircut|barber|peluquer|pelo(?![a-z])|cabello|cabelo|corte|cort(?:o|aron|ar|ou|ado)(?![a-z])|trim|barbe|salon|rapad',
  ),
  'first-beach': R('first', 'beach|playa|praia|ocean|sea(?![a-z])|mar(?![a-z])|sand|arena(?![a-z])|areia|shore|orilla'),
  'first-pool': R(
    'first',
    'pool|piscina|swim|swam|alberca|pileta|nadar|nado(?![a-z])|water|agua|splash|chapuz|lake|lago|sea(?![a-z])|mar(?![a-z])|ocean',
  ),
  'first-snow': R('first', 'snow|nieve|neve(?![a-z])|nevad|nevo|nieva|sled|trineo'),
  'first-rain-play': R('first', 'rain|lluvi|llov|chuv|puddle|charco|poca(?![a-z])'),
  'first-plane': R('first', 'plane|flight|flew|fly(?![a-z])|flying|avion|aviao|voo(?![a-z])|vuelo|volar|voar|airplane|airport|aeropuerto|aeroporto|jet(?![a-z])'),
  'first-trip': R('first', 'trip|vacation|holiday|viaje|vacacion|viagem|ferias|travel|journey|getaway|escapada|cruise|crucero|cruzeiro|hotel|resort|paseo'),
  'first-abroad': R('first', 'abroad|overseas|extranjer|exterior|estrangeir|passport|pasaporte|passaporte|country|pais(?![a-z])|international|internacional|fuera\\sde|fora\\sdo'),
  'first-camping': R('first', 'camp|tent(?![a-z])|carpa|tienda|acamp|barraca|fogata|bonfire|saco\\sde\\sdormir|sleeping\\sbag'),
  'first-sleepover': R('first', 'sleepover|sleep\\sover|slept|overnight|dorm|durm|pernoit|pijamada|pijama|noche|noite|night'),
  'first-pet': R(
    'first',
    'pet(?![a-z])|pets|dog|puppy|cat(?![a-z])|kitten|perr|cachorr|gat[oa](?![a-z])|gatit|mascota|animal|bird|pajar|passaro|fish|pez(?![a-z])|hamster|conejo|rabbit|coelho|tortug|bicho|cao(?![a-z])|peixe',
  ),
  birthday: {
    kind: 'event',
    phrases:
      'birthday|bday|b\\sday|cumple\\w*|aniversar\\w*|parabens|turn(?:ed|s)?\\s(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?![a-z])',
  },
  'first-holiday-season': R(
    'first',
    'christmas|xmas|navidad|natal|hanukk|januca|holiday|diwali|kwanzaa|thanksgiving|santa|reyes|nochebuena|christmas\\stree|pascua|easter|pascoa|ramadan|eid(?![a-z])',
  ),
  'first-halloween': R('first', 'halloween|costume|disfraz|fantasia|trick\\sor\\streat|truco\\so\\strato|pumpkin|calabaza|abobora|dia\\sdas\\sbruxas'),
  'first-tooth-fairy': R('first', 'fairy|hada(?![a-z])|ratoncito|raton|fada|tooth|diente|dente'),
  'first-dentist': R('first', 'dentist|dental|odont|diente|teeth|tooth|dente'),
};

// ── Compiled forms ─────────────────────────────────────────────────────────

const LEAD = '(?<![a-z0-9])';

function compile(source: string): RegExp {
  return new RegExp(`${LEAD}(?:${source})`);
}

interface CompiledRule {
  kind: MilestoneEvidenceKind;
  subject: RegExp | null;
  phrases: RegExp | null;
  extra: RegExp | null;
}

const COMPILED: ReadonlyMap<string, CompiledRule> = new Map(
  Object.entries(MILESTONE_EVIDENCE_RULES).map(([id, rule]) => [
    id,
    {
      kind: rule.kind,
      subject: rule.subject ? compile(rule.subject) : null,
      phrases: rule.phrases ? compile(rule.phrases) : null,
      extra: rule.extra ? compile(rule.extra) : null,
    },
  ]),
);

// Explicit first-time language (es / en / pt). Spanish "primero" is
// deliberately excluded: it is overwhelmingly the sequencing adverb ("primero
// fuimos al parque"); the ordinal adjective is primer / primera / primeros.
const FIRST_RE = compile(
  'primer(?:a|as|os)?(?![a-z0-9])|primeir[oa]s?(?![a-z0-9])|firsts?(?![a-z0-9])|1st(?![a-z0-9])|1ra(?![a-z0-9])|1er(?![a-z0-9])',
);

// Sequencing uses of "first" that say nothing about a milestone; masked out
// before FIRST_RE runs ("at first", "first we went to the park").
const FIRST_SEQUENCING_RE = new RegExp(
  `${LEAD}(?:at\\sfirst|first\\sof\\sall|first\\sthing|first\\soff|first\\sup|first\\s(?:we|i|he|she|they|then|let)|primeiro\\s(?:fomos|fui|fiz|fez|fizemos|comemos|vamos))(?![a-z0-9])`,
  'g',
);

// Achievement language (es / en / pt) -- accepted in place of first-time
// wording for `achievement` entries. Always combined with the entry's subject.
const ACHIEVEMENT_RE = compile(
  [
    // es
    'aprend(?:io|ieron|e|er|ido)(?:\\sa)?(?![a-z0-9])',
    'ya(?![a-z0-9])',
    'por\\sfin|al\\sfin|finalmente',
    'logr(?:o|aron|ar|ado)(?![a-z0-9])',
    'consigui(?:o|eron|endo)(?![a-z0-9])',
    '(?:empez|comenz)(?:o|a|aron)\\sa(?![a-z0-9])',
    'sin\\sayuda',
    'solit[oa](?![a-z0-9])',
    '(?:el|ella)\\s(?:sol[oa]|mism[oa])(?![a-z0-9])',
    'por\\ssu\\scuenta',
    // en
    'learn(?:ed|s|t)?(?![a-z0-9])',
    'can\\s(?:now|already|finally)(?![a-z0-9])',
    'already(?![a-z0-9])',
    'finally(?![a-z0-9])',
    '(?:started|starts|began|begins)(?:\\sto|\\s[a-z]+ing)(?![a-z0-9])',
    'officially(?![a-z0-9])',
    'managed\\sto(?![a-z0-9])',
    'able\\sto(?![a-z0-9])',
    'mastered(?![a-z0-9])',
    'no\\slonger(?![a-z0-9])',
    'no\\smore(?![a-z0-9])',
    'on\\s(?:his|her|their)\\sown(?![a-z0-9])',
    'by\\s(?:himself|herself|themselves)(?![a-z0-9])',
    'without\\s(?:help|assistance)(?![a-z0-9])',
    // pt
    'aprendeu(?![a-z0-9])',
    'ja(?![a-z0-9])',
    'enfim(?![a-z0-9])',
    'conseguiu|consegue(?![a-z0-9])',
    'comecou\\sa(?![a-z0-9])',
    'sozinh[oa](?![a-z0-9])',
    'sem\\sajuda',
  ].join('|'),
);

// ── Normalization ──────────────────────────────────────────────────────────

/**
 * Folded comparison form: NFD with combining marks stripped, lowercase,
 * curly quotes straightened, every run of non-alphanumeric characters (spaces,
 * punctuation, emoji, ellipses) collapsed to one space, trimmed.
 */
export function foldForEvidence(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const MIN_EVIDENCE_CHARS = 8;
export const MAX_EVIDENCE_CHARS = 400;

/** True when `quote` appears verbatim in `text` (after folding). Word-boundary
 * aware so a quote cannot match inside a longer word. */
export function quoteIsVerbatim(quote: string, text: string): boolean {
  const foldedQuote = foldForEvidence(quote);
  if (foldedQuote.length < MIN_EVIDENCE_CHARS || foldedQuote.length > MAX_EVIDENCE_CHARS) return false;
  const foldedText = ` ${foldForEvidence(text)} `;
  return foldedText.includes(` ${foldedQuote} `);
}

// ── The gate ────────────────────────────────────────────────────────────────

export type EvidenceRejection =
  | 'unknown_milestone'
  | 'no_evidence'
  | 'quote_not_in_text'
  | 'no_explicit_language'
  | 'subject_not_mentioned'
  | 'event_not_stated';

export type EvidenceVerdict = { ok: true } | { ok: false; reason: EvidenceRejection };

/** Language gate + subject gate on a quote (no verbatim check -- that needs
 * the memory text). Pure function of (milestone id, quote). */
export function evaluateMilestoneEvidence(milestoneId: string, quote: string): EvidenceVerdict {
  const rule = COMPILED.get(milestoneId);
  if (!rule) return { ok: false, reason: 'unknown_milestone' };

  const folded = foldForEvidence(quote);
  if (!folded) return { ok: false, reason: 'no_evidence' };

  // A complete standalone statement of this exact milestone.
  if (rule.phrases?.test(folded)) return { ok: true };
  if (rule.kind === 'event') return { ok: false, reason: 'event_not_stated' };

  const unsequenced = folded.replace(FIRST_SEQUENCING_RE, ' ');
  const hasFirst = FIRST_RE.test(unsequenced);
  const hasAchievement =
    rule.kind === 'achievement' && (ACHIEVEMENT_RE.test(folded) || (rule.extra?.test(folded) ?? false));
  if (!hasFirst && !hasAchievement) return { ok: false, reason: 'no_explicit_language' };

  if (rule.subject && !rule.subject.test(folded)) return { ok: false, reason: 'subject_not_mentioned' };
  return { ok: true };
}

/** Full live gate for a model claim: quote must be verbatim in the memory
 * text AND pass `evaluateMilestoneEvidence`. */
export function verifyMilestoneEvidence(
  milestoneId: string,
  evidence: string | null | undefined,
  memoryText: string | null | undefined,
): EvidenceVerdict {
  if (!COMPILED.has(milestoneId)) return { ok: false, reason: 'unknown_milestone' };
  if (!evidence || !evidence.trim() || !memoryText) return { ok: false, reason: 'no_evidence' };
  if (!quoteIsVerbatim(evidence, memoryText)) return { ok: false, reason: 'quote_not_in_text' };
  return evaluateMilestoneEvidence(milestoneId, evidence);
}

const SENTENCE_SPLIT_RE = /[.!?¡¿;…\n\r]+/u;

/**
 * Text-only gate for stored rows that have no evidence quote (backfill): does
 * ANY sentence -- or any two adjacent sentences -- of the memory text itself
 * pass `evaluateMilestoneEvidence`? Same rules as the live gate, applied to
 * windows of the memory's own words, so "first" in one sentence and a
 * haircut in a distant sentence do not combine.
 */
export function memoryTextStatesMilestone(milestoneId: string, memoryText: string | null | undefined): EvidenceVerdict {
  if (!COMPILED.has(milestoneId)) return { ok: false, reason: 'unknown_milestone' };
  if (!memoryText || !memoryText.trim()) return { ok: false, reason: 'no_evidence' };

  const sentences = memoryText.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  let best: EvidenceRejection = 'no_explicit_language';
  const consider = (window: string): boolean => {
    const verdict = evaluateMilestoneEvidence(milestoneId, window);
    if (verdict.ok) return true;
    if (verdict.reason === 'subject_not_mentioned') best = verdict.reason;
    return false;
  };

  for (let index = 0; index < sentences.length; index += 1) {
    if (consider(sentences[index])) return { ok: true };
    if (index + 1 < sentences.length && consider(`${sentences[index]} ${sentences[index + 1]}`)) return { ok: true };
  }
  return { ok: false, reason: best };
}

/** One-line requirement tag for a catalog entry, shown to the model next to
 * the entry in the prompt so it knows what the text must say. */
export function describeEvidenceRequirement(milestoneId: string): string {
  const rule = MILESTONE_EVIDENCE_RULES[milestoneId];
  if (!rule) return '';
  switch (rule.kind) {
    case 'first':
      return 'needs explicit first-time wording';
    case 'achievement':
      return 'needs explicit first-time or achievement wording';
    case 'event':
      return 'needs the event itself stated';
  }
}

/** Catalog ids with no evidence rule (must always be empty; a test pins it). */
export function catalogIdsMissingEvidenceRule(): string[] {
  return MILESTONES.filter((entry) => !(entry.id in MILESTONE_EVIDENCE_RULES)).map((entry) => entry.id);
}
