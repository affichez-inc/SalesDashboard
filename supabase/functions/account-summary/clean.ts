// Turns CRM email and note HTML into short plain text for the model.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
  agrave: 'à', acirc: 'â', Agrave: 'À', Acirc: 'Â', ccedil: 'ç', Ccedil: 'Ç',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', Ocirc: 'Ô', ugrave: 'ù', ucirc: 'û', uuml: 'ü', oelig: 'œ',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', ndash: '–', mdash: '—', deg: '°', euro: '€', copy: '©', reg: '®', middot: '·',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

/** HTML (or plain text) to text with line breaks kept and whitespace collapsed. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const text = html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

// A reply's quoted history starts at the first of these lines.
const QUOTE_START = [
  /^Le .{4,160}a écrit\s*:?\s*$/i,
  /^On .{4,160}wrote\s*:?\s*$/i,
  /^-{2,}\s*(Original Message|Message d'origine|Forwarded message|Message transféré)/i,
  /^_{8,}\s*$/,
  /^(De|From)\s*:\s*.+$/i,
];

// Lines that carry no content: device footers, bare links, and signature lines.
const NOISE_LINE = [
  /^(Envoyé|Sent) (de|from) (mon|my) /i,
  /^(Get|Obtenir) Outlook/i,
  /^https?:\/\/\S+$/i,
  /^www\.\S+$/i,
  /^[\d\s().+#-]{5,}$/,                         // a phone number wrapped onto its own line
  /^[\p{L}&' ]{2,30}\s*:\s*[\d\s().+#-]*$/u,     // "Bureau Laval : 514", "Sans frais:"
];
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(poste|ext\.?|#)\s*\d+)?/gi;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const URL_TEXT = /\b(https?:\/\/|www\.)\S+/gi;
/** Fewer letters than this once contact details are removed: a signature line. */
const MIN_PROSE_LETTERS = 25;

function letters(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

/**
 * A line is kept when it says something, contact details included. A line that
 * is mostly a phone number, an email address or a link is a signature line.
 */
function cleanLine(line: string): string | null {
  if (NOISE_LINE.some((re) => re.test(line))) return null;
  const hasContact = PHONE.test(line) || EMAIL.test(line);
  PHONE.lastIndex = 0;
  EMAIL.lastIndex = 0;
  if (!hasContact) return line;
  const prose = line.replace(PHONE, '').replace(EMAIL, '').replace(URL_TEXT, '');
  return letters(prose) < MIN_PROSE_LETTERS ? null : line;
}

/** Drops noise lines and everything after a "--" signature delimiter. */
export function stripNoise(text: string): string {
  const lines = text.split('\n');
  const sig = lines.findIndex((l) => /^--\s*$/.test(l));
  return (sig >= 0 ? lines.slice(0, sig) : lines)
    .map(cleanLine)
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Out-of-office and other automatic replies. */
export function isAutoReply(subject: string | null | undefined): boolean {
  return /r[ée]ponse automatique|automatic reply|auto[- ]?reply|out of (the )?office|absent(e)? du bureau|en vacances|présentement absent/i
    .test(subject ?? '');
}

/**
 * The new part of an email: quoted replies, forwarded headers and signature
 * lines removed. Falls back to the full text only when nothing new is left,
 * which is what a pure forward looks like.
 */
export function emailBody(html: string | null | undefined, maxChars: number): string {
  const full = htmlToText(html);
  const lines = full.split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('>')) { cut = i; break; }
    if (QUOTE_START.some((re) => re.test(line))) {
      // A "De :" line only opens a quote when an Outlook header block follows.
      if (/^(De|From)\s*:/i.test(line)) {
        const next = lines.slice(i + 1, i + 5).join('\n');
        if (!/^(Envoyé|Sent|Date|À|To|Objet|Subject)\s*:/im.test(next)) continue;
      }
      cut = i;
      break;
    }
  }
  const fresh = stripNoise(lines.slice(0, cut).join('\n'));
  return truncate(fresh || stripNoise(full), maxChars);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trimEnd() + ' […]';
}

/** One line, for subjects and titles. */
export function oneLine(text: string | null | undefined, maxChars = 140): string {
  return truncate(htmlToText(text).replace(/\s*\n\s*/g, ' '), maxChars);
}
