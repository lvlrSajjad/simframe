#!/usr/bin/env node
// Generate docs/ARTICLE.md from docs/agents-shouldnt-blink.html.
//
//   node scripts/article-md.mjs            # write it
//   node scripts/article-md.mjs --check    # fail if it is out of date
//
// **Why generated rather than kept in step by hand.** The two were written as a
// pair, with a note at the top of the Markdown saying it was the source of
// record and to edit both together. Then the page grew several sections the
// Markdown never got — the local supervisor, the capacity comparison — and the
// note stayed there being wrong, which is worse than no note: the next person
// follows it. Replacing a stale instruction with a stale *warning* would have
// been the same mistake one level up.
//
// So the page is the source and this is the projection. Two copies of a
// document cannot drift when one of them is derived, and `--check` in CI means
// they cannot drift silently even for a commit.
//
// This is not a general HTML-to-Markdown converter and should not become one.
// It understands exactly the constructs that article uses, and it *throws* on
// anything it does not recognise rather than dropping it — a converter that
// silently skips an unfamiliar tag produces a document that looks complete and
// is not, which is the failure mode this whole file exists to prevent.
//
// That promise had a hole in it for as long as it existed, and the hole was
// not an unfamiliar tag but the space between two familiar ones. The scanner
// matched a list of constructs and stepped over everything in between without
// looking, so the colophon's body — a text node the page puts straight inside
// its container, with no `<p>` around it — was not unhandled, it was unseen,
// and the document ended on a bare **On the numbers** label. Refusing what you
// do not recognise is only half of it; you have to look everywhere first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'docs', 'agents-shouldnt-blink.html');
const TARGET = path.join(ROOT, 'docs', 'ARTICLE.md');

const ENTITIES = {
  mdash: '—', ndash: '–', nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  times: '×', rarr: '→', larr: '←', hellip: '…', plusmn: '±', deg: '°',
  middot: '·', bull: '•', frac12: '½', le: '≤', ge: '≥', minus: '−', apos: "'",
};

/** Entities, then inline tags, then whitespace. Order matters. */
function inline(html) {
  let out = html
    // The faculty spans open a paragraph and name the thing it defines —
    // "Eyes", "Hand", "Memory" — with no separator in the HTML because the
    // stylesheet supplies one.
    .replace(/<span class="faculty">([\s\S]*?)<\/span>/g, (_, t) => `<strong>${t}</strong> — `)
    // An abbreviation carries its expansion in the title attribute, which a
    // reader of the Markdown has no way to hover over. Keep both.
    .replace(/<abbr title="([^"]*)"[^>]*>([\s\S]*?)<\/abbr>/g, (_, full, t) => `${stripTags(t)} (${full})`)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, text) => `[${inline(text)}](${href})`)
    .replace(/<code>([\s\S]*?)<\/code>/g, (_, t) => `\`${stripTags(t)}\``)
    .replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/g, (_, t) => `**${inline(t)}**`)
    .replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/g, (_, t) => `*${inline(t)}*`)
    .replace(/<br\s*\/?>/g, '  \n');
  const left = out.match(/<(?!\/)[a-z]/i);
  if (left) throw new Error(`unhandled inline tag near: ${out.slice(Math.max(0, left.index - 40), left.index + 60)}`);
  return decode(out).replace(/\s+/g, ' ').trim();
}

const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-zA-Z0-9]+);/g, (m, name) => {
    if (!(name in ENTITIES)) throw new Error(`unknown entity &${name};`);
    return ENTITIES[name];
  });

const stripTags = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** A table, as GitHub-flavoured Markdown. */
function table(html) {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((c) => inline(c[2])));
  if (!rows.length) return [];
  const head = /<thead>/.test(html) ? rows[0] : rows[0].map(() => ' ');
  const body = /<thead>/.test(html) ? rows.slice(1) : rows;
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  return [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${pad(r).join(' | ')} |`),
  ];
}

/**
 * Tags that hold blocks without being one. The scanner walks through these; a
 * tag in a gap that is *not* one of them is content, and `inline` throws on it.
 */
const CONTAINER = /<\/?(?:div|ul|ol|section|header|figure)\b[^>]*>/g;

/**
 * What the scanner stepped over between two blocks. Containers are expected.
 * Anything left is a text node the page put straight inside a container rather
 * than in a `<p>` — the colophon's body is one — and it is content like any
 * other. Nothing looked in the gaps before, so every generated copy of this
 * document ended on a dangling **On the numbers** label with its paragraph
 * gone: exactly the silent-drop failure the rest of this file refuses.
 */
function gap(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(CONTAINER)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((text) => ({ kind: 'p', text: inline(text) }));
}

/** Everything inside one `<section>` (or the `<header>`), in order. */
function blocks(html) {
  const out = [];
  // One pass over the constructs the article actually uses. `lastIndex`
  // walking rather than nested parsing, because the document is flat inside a
  // section and a real parser here would be a dependency. What the pass does
  // *not* match is handed to `gap` rather than skipped.
  const re = new RegExp([
    '<h([123])>([\\s\\S]*?)<\\/h\\1>',
    '<p class="sec-label">([\\s\\S]*?)<\\/p>',
    '<p class="panel-label">([\\s\\S]*?)<\\/p>',
    '<span class="amend-label">([\\s\\S]*?)<\\/span>',
    '<p\\b[^>]*>([\\s\\S]*?)<\\/p>',
    '<table>([\\s\\S]*?)<\\/table>',
    '<pre>([\\s\\S]*?)<\\/pre>',
    '<li>([\\s\\S]*?)<\\/li>',
    '<figcaption>([\\s\\S]*?)<\\/figcaption>',
    '<svg\\b([^>]*)>[\\s\\S]*?<\\/svg>',
  ].join('|'), 'g');
  let m;
  let cursor = 0;
  while ((m = re.exec(html)) !== null) {
    out.push(...gap(html.slice(cursor, m.index)));
    cursor = re.lastIndex;
    const [, level, heading, sec, panel, amend, para, tbl, pre, li, caption, svg] = m;
    if (heading != null) out.push({ kind: 'h', level: Number(level), text: inline(heading) });
    else if (sec != null) out.push({ kind: 'kicker', text: inline(sec) });
    else if (panel != null) out.push({ kind: 'label', text: inline(panel) });
    else if (amend != null) out.push({ kind: 'label', text: inline(amend) });
    else if (para != null) out.push({ kind: 'p', text: inline(para) });
    else if (tbl != null) out.push({ kind: 'table', lines: table(tbl) });
    else if (pre != null) out.push({ kind: 'pre', text: decode(stripTagsPreserving(pre)) });
    else if (li != null) out.push({ kind: 'li', text: inline(li) });
    else if (caption != null) out.push({ kind: 'p', text: inline(caption) });
    // A diagram cannot be projected into Markdown, but its `aria-label` is
    // already the prose a screen reader gets, so that is what a reader of the
    // Markdown gets too. An undescribed diagram is content this cannot carry,
    // so it throws rather than quietly becoming nothing.
    else if (svg != null) {
      const label = svg.match(/aria-label="([^"]*)"/);
      if (!label) throw new Error('<svg> with no aria-label — nothing to project');
      out.push({ kind: 'figure', text: inline(label[1]) });
    }
  }
  out.push(...gap(html.slice(cursor)));
  return out;
}

/** `<pre>` keeps its newlines; only tags come out. */
const stripTagsPreserving = (s) => s.replace(/<[^>]+>/g, '').replace(/^\n/, '').replace(/\s+$/, '');

/** One section's or the header's blocks, appended to the document. */
function emit(lines, bs) {
  let pendingKicker = null;
  let inList = false;
  for (const b of bs) {
    if (b.kind !== 'li' && inList) { lines.push(''); inList = false; }
    switch (b.kind) {
      // The kicker precedes its heading on the page and reads as a label for
      // it, so it is held until the heading arrives rather than emitted where
      // it was found.
      case 'kicker': pendingKicker = b.text; break;
      case 'h':
        if (pendingKicker) { lines.push(`*${pendingKicker}*`, ''); pendingKicker = null; }
        // `<h1>` is the title, already emitted above, so the page's `<h2>`
        // sections are the document's second level and not its third.
        lines.push(`${'#'.repeat(b.level)} ${b.text}`, '');
        break;
      case 'label': lines.push(`**${b.text}**`, ''); break;
      case 'p': lines.push(b.text, ''); break;
      case 'figure': lines.push(`*Figure — ${b.text}*`, ''); break;
      case 'li': lines.push(`- ${b.text}`); inList = true; break;
      case 'table': lines.push(...b.lines, ''); break;
      case 'pre': lines.push('```', b.text, '```', ''); break;
      default: throw new Error(`unhandled block ${b.kind}`);
    }
  }
  if (inList) lines.push('');
}

export function render(html) {
  const title = stripTags(html.match(/<h1>([\s\S]*?)<\/h1>/)[1]);
  const kicker = stripTags(html.match(/<p class="kicker">([\s\S]*?)<\/p>/)[1]);
  // The rest of the header: the deck, the figure, the provenance line. This
  // used to look for `<p class="standfirst">`, a class the page does not have,
  // so the match was always null and the branch that emitted it never ran —
  // the same silent drop as the colophon, arrived at from the other end. The
  // header is walked with the section machinery now, minus the two blocks
  // emitted by hand above.
  const header = (html.match(/<header>([\s\S]*?)<\/header>/)?.[1] ?? '')
    .replace(/<h1>[\s\S]*?<\/h1>/, '')
    .replace(/<p class="kicker">[\s\S]*?<\/p>/, '');

  const lines = [
    `# ${title}`,
    '',
    `*${kicker}*`,
    '',
    '> **This file is generated** from [`agents-shouldnt-blink.html`](agents-shouldnt-blink.html)',
    '> by `scripts/article-md.mjs`. Edit the page, not this — a hand-kept copy of a',
    '> document is a copy that drifts, and this one did.',
    '>',
    '> The measurements, with N, median, p95 and the mistakes made getting to each,',
    '> are in [`BENCHMARKS.md`](BENCHMARKS.md); what we expected before measuring is',
    '> in [`EXPERIMENTS.md`](EXPERIMENTS.md).',
    '',
  ];
  emit(lines, blocks(header));
  lines.push('---', '');

  for (const section of html.match(/<section>[\s\S]*?<\/section>/g) ?? []) emit(lines, blocks(section));

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// Only as a command. This used to run on import, which meant the test that
// asserts the page and the Markdown are one document regenerated the Markdown
// before reading it back and compared the output to itself. It could not fail,
// and it did not — the colophon's missing paragraph sat under a green suite
// for as long as it existed. `--check` in CI was the only real gate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const md = render(fs.readFileSync(SOURCE, 'utf8'));

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (current === md) {
      console.log(`docs/ARTICLE.md is in step with the page (${md.split('\n').length} lines)`);
      process.exit(0);
    }
    console.error('docs/ARTICLE.md is out of date with docs/agents-shouldnt-blink.html.');
    console.error('Run: node scripts/article-md.mjs');
    process.exit(1);
  }

  fs.writeFileSync(TARGET, md);
  console.log(`wrote docs/ARTICLE.md — ${md.split('\n').length} lines from ${SOURCE.split('/').pop()}`);
}
