// Property lists, parsed without a dependency.
//
// Below the platform boundary on purpose. A plist is not a neutral file format
// this project happens to read — it is how one platform stores what an app
// believes, and `plutil` is that platform's tool. Android's answer to the same
// question is a different file in a different shape, which is why the parsing
// lives beside the backend that needs it rather than above the seam.
//
// **Why XML and not JSON.** `plutil -convert json` is the obvious route and it
// does not work: measured across the twenty real `Library/Preferences` plists
// on the bench device, **six of them failed to convert** — 30%, because JSON
// has no representation for `<data>` or `<date>` and plutil refuses rather than
// inventing one. `-convert xml1` succeeded on all twenty. A format that drops
// three in ten real files is not a parser, it is a sampler.
//
// The XML here is machine-written by plutil, so this is a reader for that
// output and not a general XML parser: no namespaces, no processing
// instructions beyond the declaration, no mixed content. It is strict about
// what it does not understand — an unknown tag throws rather than being skipped,
// because a silently dropped key in a store read is a wrong answer about what
// an app believes, and this whole feature exists to be trusted on that point.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the five XML entities plutil emits, plus numeric escapes. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/**
 * A `<data>` value.
 *
 * Kept as a tagged object rather than decoded to a Buffer or dropped. The
 * caller is usually a human asking what an app persisted, and "a 4 KB blob"
 * is a real and often sufficient answer — while silently omitting the key
 * would misreport the store as not having it.
 */
const dataValue = (base64) => {
  const clean = base64.replace(/\s+/g, '');
  return {
    __type: 'data',
    bytes: Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0),
    base64: clean,
  };
};

/**
 * Parse the XML property list plutil writes.
 *
 * @param {string} xml output of `plutil -convert xml1 -o -`
 * @returns {*} the plist's root value — normally an object
 */
export function parse(xml) {
  const src = String(xml);
  // Everything before <plist> is the declaration and the DOCTYPE, neither of
  // which carries data.
  const start = src.indexOf('<plist');
  if (start < 0) throw new Error('not an XML property list (no <plist> element)');
  let i = src.indexOf('>', start);
  if (i < 0) throw new Error('not an XML property list (unterminated <plist>)');
  i += 1;

  /** The next tag at or after `i`, skipping text that is only whitespace. */
  const nextTag = () => {
    const open = src.indexOf('<', i);
    if (open < 0) return null;
    const close = src.indexOf('>', open);
    if (close < 0) throw new Error('unterminated tag in property list');
    const raw = src.slice(open + 1, close);
    i = close + 1;
    const selfClosing = raw.endsWith('/');
    const name = raw.replace(/\/$/, '').trim().split(/\s/)[0];
    return { name: name.replace(/^\//, ''), closing: raw.startsWith('/'), selfClosing };
  };

  /** Text up to the matching close tag, which plutil never nests inside a leaf. */
  const textUntilClose = (tag) => {
    const close = src.indexOf(`</${tag}>`, i);
    if (close < 0) throw new Error(`unterminated <${tag}> in property list`);
    const text = src.slice(i, close);
    i = close + tag.length + 3;
    return text;
  };

  const readValue = (tag) => {
    switch (tag.name) {
      case 'true': return true;
      case 'false': return false;
      case 'string': return tag.selfClosing ? '' : decodeEntities(textUntilClose('string'));
      case 'integer': {
        const text = textUntilClose('integer').trim();
        const n = Number(text);
        // A plist integer is 64-bit and JavaScript's is not. Returning a
        // silently-rounded number would be a wrong answer about a stored value,
        // so the exact digits survive as a string and the shape says why.
        if (!Number.isSafeInteger(n)) return { __type: 'integer', exact: text };
        return n;
      }
      case 'real': return Number(textUntilClose('real').trim());
      case 'date': return { __type: 'date', iso: textUntilClose('date').trim() };
      case 'data': return dataValue(textUntilClose('data'));
      case 'dict': {
        if (tag.selfClosing) return {};
        const out = {};
        for (;;) {
          const t = nextTag();
          if (!t) throw new Error('unterminated <dict> in property list');
          if (t.closing && t.name === 'dict') return out;
          if (t.name !== 'key') throw new Error(`expected <key> in <dict>, found <${t.name}>`);
          const key = t.selfClosing ? '' : decodeEntities(textUntilClose('key'));
          const vt = nextTag();
          if (!vt) throw new Error(`<key>${key}</key> has no value`);
          out[key] = readValue(vt);
        }
      }
      case 'array': {
        if (tag.selfClosing) return [];
        const out = [];
        for (;;) {
          const t = nextTag();
          if (!t) throw new Error('unterminated <array> in property list');
          if (t.closing && t.name === 'array') return out;
          out.push(readValue(t));
        }
      }
      default:
        // Deliberately not a skip. See the note at the top of this file.
        throw new Error(`unsupported property-list element <${tag.name}>`);
    }
  };

  const root = nextTag();
  if (!root || root.closing) return null;
  return readValue(root);
}

/**
 * What kind of thing a parsed value is, in one word, for a listing.
 *
 * `typeof` is not enough: the tagged shapes above are objects, and calling a
 * date "object" in a store listing tells the reader nothing they wanted.
 */
export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return value.__type ?? 'dict';
  return typeof value;
}
