// Romanization for languages whose target script isn't the Latin alphabet
// — shown as a second line under the native-script result (see
// js/main.js), never replacing it, so the reader gets both the real
// translation and a way to read it aloud without knowing the script.
// Pure character substitution, no network or external dependency — safe
// to apply to every result in these languages, and fully deterministic
// (same input always romanizes the same way).
//
// makeTransliterator() does the actual per-character substitution, with
// case preserved from the source character. `digraphs` (checked longest
// match first, before falling back to single characters) exist only for
// Greek, where a handful of two-letter combinations represent a single
// sound that isn't the sum of its parts (e.g. μπ sounds like "b", not
// "mp").
function makeTransliterator(map, digraphs = []) {
  const sortedDigraphs = [...digraphs].sort((a, b) => b[0].length - a[0].length);

  return function transliterate(text) {
    if (!text) return text;
    const lower = text.toLowerCase();
    let out = '';
    let i = 0;
    while (i < text.length) {
      let matched = false;
      for (const [seq, replacement] of sortedDigraphs) {
        if (lower.startsWith(seq, i)) {
          const original = text.slice(i, i + seq.length);
          const isUpper = original[0] !== original[0].toLowerCase();
          out += isUpper ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const ch = text[i];
      const chLower = ch.toLowerCase();
      const mapped = map[chLower];
      if (mapped === undefined) {
        out += ch;
      } else {
        out += ch !== chLower ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
      }
      i += 1;
    }
    return out;
  };
}

// Bulgarian: the official government "Streamlined System" (what Bulgaria
// itself uses on road signs and in passports since 2006).
const BG_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};
export const transliterateBulgarian = makeTransliterator(BG_MAP);

// Russian: a common simplified phonetic scheme (close to BGN/PCGN). Hard
// and soft signs (ъ, ь) have no sound of their own, so they're dropped
// rather than mapped to a letter.
const RU_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};
export const transliterateRussian = makeTransliterator(RU_MAP);

// Greek: a common phonetic scheme. The digraphs below aren't optional
// flourish — μπ/ντ/γκ/τσ/τζ/αυ/ευ each represent one sound that a plain
// per-letter map would render wrong (e.g. "μπάλα" letter-by-letter would
// come out "mpála" instead of the actual "bála").
const EL_MAP = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k',
  λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't',
  υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
  ά: 'a', έ: 'e', ή: 'i', ί: 'i', ό: 'o', ύ: 'y', ώ: 'o', ΐ: 'i', ΰ: 'y',
};
const EL_DIGRAPHS = [
  ['μπ', 'b'], ['ντ', 'd'], ['γκ', 'g'], ['τσ', 'ts'], ['τζ', 'dz'],
  ['αυ', 'av'], ['ευ', 'ev'],
];
export const transliterateGreek = makeTransliterator(EL_MAP, EL_DIGRAPHS);

// Keyed by target language code so js/main.js can look one up generically
// instead of hardcoding a per-language if-chain. Add a new language by
// adding a map (plus digraphs if it needs them) and one entry here.
const TRANSLITERATORS = {
  bg: transliterateBulgarian,
  ru: transliterateRussian,
  el: transliterateGreek,
};

// Returns the romanized form of `text` for `targetLang`, or null if this
// language has no romanization scheme (i.e. it's already Latin-script, or
// just not supported yet) — js/main.js uses null to mean "don't show a
// second line" rather than displaying a no-op identical copy.
export function transliterateFor(targetLang, text) {
  const fn = TRANSLITERATORS[targetLang];
  if (!fn) return null;
  const result = fn(text);
  return result === text ? null : result;
}
