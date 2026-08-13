// Cyrillic → Latin transliteration for Bulgarian, using the official
// "Streamlined System" (the scheme Bulgaria itself uses on road signs and
// in passports since 2006). Pure character substitution, no network or
// external dependency — safe to apply to every Bulgarian translation.
const BG_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

export function transliterateBulgarian(text) {
  if (!text) return text;
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = BG_MAP[lower];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    out += ch !== lower ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
  }
  return out;
}
