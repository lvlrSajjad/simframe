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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Everything inside one `<section>`, in order. */
function blocks(html) {
  const out = [];
  // One pass over the constructs the article actually uses. `lastIndex`
  // walking rather than nested parsing, because the document is flat inside a
  // section and a real parser here would be a dependency.
  const re = new RegExp([
    '<h([123])>([\\s\\S]*?)<\\/h\\1>',
    '<p class="sec-label">([\\s\\S]*?)<\\/p>',
    '<p class="panel-label">([\\s\\S]*?)<\\/p>',
    '<span class="amend-label">([\\s\\S]*?)<\\/span>',
    '<p\\b[^>]*>([\\s\\S]*?)<\\/p>',
    '<table>([\\s\\S]*?)<\\/table>',
    '<pre>([\\s\\S]*?)<\\/pre>',
    '<li>([\\s\\S]*?)<\\/li>',
  ].join('|'), 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, level, heading, sec, panel, amend, para, tbl, pre, li] = m;
    if (heading != null) out.push({ kind: 'h', level: Number(level), text: inline(heading) });
    else if (sec != null) out.push({ kind: 'kicker', text: inline(sec) });
    else if (panel != null) out.push({ kind: 'label', text: inline(panel) });
    else if (amend != null) out.push({ kind: 'label', text: inline(amend) });
    else if (para != null) out.push({ kind: 'p', text: inline(para) });
    else if (tbl != null) out.push({ kind: 'table', lines: table(tbl) });
    else if (pre != null) out.push({ kind: 'pre', text: decode(stripTagsPreserving(pre)) });
    else if (li != null) out.push({ kind: 'li', text: inline(li) });
  }
  return out;
}

/** `<pre>` keeps its newlines; only tags come out. */
const stripTagsPreserving = (s) => s.replace(/<[^>]+>/g, '').replace(/^\n/, '').replace(/\s+$/, '');

export function render(html) {
  const title = stripTags(html.match(/<h1>([\s\S]*?)<\/h1>/)[1]);
  const kicker = stripTags(html.match(/<p class="kicker">([\s\S]*?)<\/p>/)[1]);
  const standfirst = html.match(/<p class="standfirst">([\s\S]*?)<\/p>/);

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
  if (standfirst) lines.push(inline(standfirst[1]), '');
  lines.push('---', '');

  for (const section of html.match(/<section>[\s\S]*?<\/section>/g) ?? []) {
    let pendingKicker = null;
    let inList = false;
    for (const b of blocks(section)) {
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
        case 'li': lines.push(`- ${b.text}`); inList = true; break;
        case 'table': lines.push(...b.lines, ''); break;
        case 'pre': lines.push('```', b.text, '```', ''); break;
        default: throw new Error(`unhandled block ${b.kind}`);
      }
    }
    if (inList) lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const html = fs.readFileSync(SOURCE, 'utf8');
const md = render(html);

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
