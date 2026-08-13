// Small bundled word/phrase dictionaries — a last-resort fallback used only
// when neither the network translation APIs nor an on-device neural model
// are available for a given pair (see js/main.js's runTranslate()). This is
// plain word-for-word lookup with no grammar, conjugation, or word-order
// awareness, so it's deliberately labeled "approximate" wherever it's shown
// in the UI rather than presented as equivalent to a real translation.
//
// Entries are stored in the target language's native script (Cyrillic for
// Bulgarian) — romanization is applied by the same transliterateBulgarian()
// call main.js already runs on every Bulgarian result, whichever path
// produced it, so this file doesn't need to know about romanization at all.
//
// Keyed by "src:tgt" so more pairs can be added later without touching the
// lookup code. Only en:bg exists today — it's the one pair this project has
// hit in practice (no small dedicated neural model, and the multilingual
// fallback that used to cover it was removed for crashing mobile Safari).
const EN_BG = {
  // Greetings & common phrases (checked before single-word entries so a
  // phrase like "good morning" matches as a unit, not word-by-word)
  'good morning': 'добро утро',
  'good afternoon': 'добър ден',
  'good evening': 'добра вечер',
  'good night': 'лека нощ',
  'thank you': 'благодаря',
  'thanks': 'благодаря',
  'excuse me': 'извинете',
  'how are you': 'как си',
  'i am fine': 'добре съм',
  "i don't understand": 'не разбирам',
  "i don't know": 'не знам',
  "i don't speak bulgarian": 'не говоря български',
  'do you speak english': 'говориш ли английски',
  'my name is': 'казвам се',
  'nice to meet you': 'приятно ми е',
  'how much': 'колко',
  'how many': 'колко',
  'how much is it': 'колко струва',
  'help me': 'помогни ми',
  'wake up': 'събуждам се',
  'see you later': 'до скоро',
  'see you soon': 'до скоро',
  'i love you': 'обичам те',
  'happy birthday': 'честит рожден ден',
  'where is': 'къде е',
  'i want': 'искам',
  'i need': 'нуждая се от',
  'i like': 'харесвам',

  // Single words
  hello: 'здравей', hi: 'здрасти', goodbye: 'довиждане', bye: 'чао',
  please: 'моля', sorry: 'съжалявам', yes: 'да', no: 'не', maybe: 'може би',
  ok: 'добре', okay: 'добре', help: 'помощ',

  // Pronouns
  i: 'аз', you: 'ти', he: 'той', she: 'тя', it: 'то', we: 'ние', they: 'те',
  my: 'мой', your: 'твой', his: 'негов', her: 'неин', our: 'наш', their: 'техен',

  // Question words
  what: 'какво', where: 'къде', when: 'кога', who: 'кой', why: 'защо',
  how: 'как', which: 'кой',

  // Numbers
  one: 'едно', two: 'две', three: 'три', four: 'четири', five: 'пет',
  six: 'шест', seven: 'седем', eight: 'осем', nine: 'девет', ten: 'десет',
  eleven: 'единадесет', twelve: 'дванадесет', twenty: 'двадесет',
  thirty: 'тридесет', hundred: 'сто', thousand: 'хиляда',

  // Time
  today: 'днес', tomorrow: 'утре', yesterday: 'вчера', now: 'сега',
  later: 'по-късно', morning: 'сутрин', afternoon: 'следобед',
  evening: 'вечер', night: 'нощ', day: 'ден', week: 'седмица',
  month: 'месец', year: 'година', time: 'време',

  // Days of the week
  monday: 'понеделник', tuesday: 'вторник', wednesday: 'сряда',
  thursday: 'четвъртък', friday: 'петък', saturday: 'събота', sunday: 'неделя',

  // Common verbs (base/dictionary forms)
  have: 'имам', want: 'искам', need: 'нужен', go: 'отивам', come: 'идвам',
  eat: 'ям', drink: 'пия', sleep: 'спя', work: 'работя', play: 'играя',
  buy: 'купувам', sell: 'продавам', give: 'давам', take: 'вземам',
  open: 'отварям', close: 'затварям', start: 'започвам', stop: 'спирам',
  use: 'използвам', make: 'правя', do: 'правя', say: 'казвам', tell: 'казвам',
  ask: 'питам', answer: 'отговарям', find: 'намирам', lose: 'губя',
  wait: 'чакам', stay: 'оставам', leave: 'тръгвам', arrive: 'пристигам',
  call: 'обаждам се', write: 'пиша', read: 'чета', learn: 'уча',
  teach: 'уча', walk: 'вървя', run: 'тичам', drive: 'шофирам', fly: 'летя',
  swim: 'плувам', sit: 'седя', stand: 'стоя', love: 'обичам',
  like: 'харесвам', know: 'знам', see: 'виждам', hear: 'чувам',
  speak: 'говоря', understand: 'разбирам',

  // Common nouns
  water: 'вода', food: 'храна', bread: 'хляб', milk: 'мляко',
  coffee: 'кафе', tea: 'чай', house: 'къща', room: 'стая', door: 'врата',
  window: 'прозорец', table: 'маса', chair: 'стол', bed: 'легло',
  car: 'кола', bus: 'автобус', train: 'влак', airport: 'летище',
  station: 'гара', hotel: 'хотел', restaurant: 'ресторант', shop: 'магазин',
  market: 'пазар', money: 'пари', price: 'цена', ticket: 'билет',
  passport: 'паспорт', phone: 'телефон', computer: 'компютър',
  book: 'книга', pen: 'писалка', paper: 'хартия', bag: 'чанта',
  key: 'ключ', friend: 'приятел', family: 'семейство', mother: 'майка',
  father: 'баща', brother: 'брат', sister: 'сестра', son: 'син',
  daughter: 'дъщеря', child: 'дете', man: 'мъж', woman: 'жена',
  person: 'човек', name: 'име', city: 'град', country: 'държава',
  street: 'улица', world: 'свят',

  // Adjectives
  big: 'голям', small: 'малък', hot: 'горещ', cold: 'студен', good: 'добър',
  bad: 'лош', new: 'нов', old: 'стар', fast: 'бърз', slow: 'бавен',
  easy: 'лесен', difficult: 'труден', happy: 'щастлив', sad: 'тъжен',
  beautiful: 'красив', expensive: 'скъп', cheap: 'евтин', closed: 'затворен',
  near: 'близо', far: 'далеч', left: 'ляво', right: 'дясно', up: 'нагоре',
  down: 'надолу', here: 'тук', there: 'там',

  // Colors
  red: 'червен', blue: 'син', green: 'зелен', yellow: 'жълт',
  black: 'черен', white: 'бял', orange: 'оранжев', purple: 'лилав',
  pink: 'розов', brown: 'кафяв', gray: 'сив', grey: 'сив',
};

const DICTIONARIES = {
  'en:bg': EN_BG,
};

export function hasDictionary(source, target) {
  return Boolean(DICTIONARIES[`${source}:${target}`]);
}

// Matches word tokens (letters plus the two apostrophe characters English
// contractions use) — everything else (spaces, punctuation) is copied
// through untouched so the result keeps the original's shape.
const WORD_RE = /[A-Za-z'’]+/g;

function normalize(word) {
  return word.toLowerCase().replace(/’/g, "'");
}

// Word-for-word substitution: at each position, try the longest run of
// consecutive words (up to 4) that are separated by nothing but whitespace
// in the source text, so multi-word entries like "good morning" match as a
// phrase; falls back to shorter spans and finally to leaving a word
// untranslated if nothing in the dictionary matches it. Returns null if
// there's no dictionary at all for this pair.
export function translateWithDictionary(text, source, target) {
  const dict = DICTIONARIES[`${source}:${target}`];
  if (!dict) return null;

  const matches = [...text.matchAll(WORD_RE)];
  if (matches.length === 0) return { text, matchedWords: 0, totalWords: 0 };

  let result = '';
  let cursor = 0;
  let i = 0;
  let matchedWords = 0;

  while (i < matches.length) {
    const maxSpan = Math.min(4, matches.length - i);
    let usedSpan = 0;
    let phraseValue = null;

    for (let span = maxSpan; span >= 1; span -= 1) {
      let contiguous = true;
      for (let k = 0; k < span - 1; k += 1) {
        const gapStart = matches[i + k].index + matches[i + k][0].length;
        const gapEnd = matches[i + k + 1].index;
        if (!/^\s+$/.test(text.slice(gapStart, gapEnd))) { contiguous = false; break; }
      }
      if (!contiguous) continue;
      const key = matches.slice(i, i + span).map((m) => normalize(m[0])).join(' ');
      if (dict[key]) { phraseValue = dict[key]; usedSpan = span; break; }
    }

    const first = matches[i];
    result += text.slice(cursor, first.index);

    if (phraseValue) {
      const startsUpper = first[0][0] !== first[0][0].toLowerCase();
      result += startsUpper ? phraseValue.charAt(0).toUpperCase() + phraseValue.slice(1) : phraseValue;
      matchedWords += usedSpan;
      const last = matches[i + usedSpan - 1];
      cursor = last.index + last[0].length;
      i += usedSpan;
    } else {
      result += first[0]; // no entry for this word — leave it as-is
      cursor = first.index + first[0].length;
      i += 1;
    }
  }
  result += text.slice(cursor);

  return { text: result, matchedWords, totalWords: matches.length };
}
