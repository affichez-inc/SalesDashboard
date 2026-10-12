// Normalisation of contact data for a Meta customer-list audience.
//
// Meta hashes its own users' data after normalising it the same way, so a value
// matches only if it was normalised exactly as Meta does before hashing. The
// rules, per key, from the Marketing API customer-file guide (v25.0):
//
//   EMAIL    trimmed, lowercase
//   PHONE    digits only, with the country code, no leading zeros
//   FN, LN   a-z only, lowercase, no punctuation; accents folded (é → e),
//            which the guide gives as the best-matching form
//   CT       a-z only, lowercase, no spaces or punctuation
//   ST       outside the US: the full name, lowercase, a-z only ("quebec")
//   ZIP      lowercase, no spaces; the whole Canadian code ("g1v4m6"),
//            the first five digits of a US one
//   COUNTRY  ISO 3166-1 alpha-2, lowercase ("ca")
//
// Every function returns null for a value that cannot be normalised, and the
// caller sends "" for it: Meta reads an empty cell as "unknown", whereas the
// hash of an empty string would be a value that matches nobody.

import { createHash } from 'node:crypto';

/** é → e, Œ → oe, ø → o, then lowercase. */
export function fold(v: string): string {
  return v
    .replace(/[Œœ]/g, 'oe').replace(/[Ææ]/g, 'ae').replace(/ß/g, 'ss')
    .replace(/[Øø]/g, 'o').replace(/[Łł]/g, 'l').replace(/[Đđ]/g, 'd')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Letters a-z only, after folding. */
function lettersOnly(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = fold(v).replace(/[^a-z]/g, '');
  return s || null;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;

export function normEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return EMAIL_SHAPE.test(s) ? s : null;
}

// Same rule as formatPhone in the frontend: an extension is cut off before the
// digits are counted, so "514 606-0878 poste 12" is a ten-digit number.
const PHONE_EXTENSION = /\s*(?:,|;|#|x|ext\.?|extension|poste|p\.)\s*\d{1,6}\s*$/i;

/**
 * North American numbers become "1" + ten digits. A number written with a "+"
 * and another country code is kept as its digits. Anything else - too short,
 * an area code starting with 0 or 1 - is dropped: a wrong number hashed is a
 * row that matches nobody, or somebody else.
 */
export function normPhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  const base = trimmed.replace(PHONE_EXTENSION, '');
  const digits = base.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length === 10 && !/^[01]/.test(local) && !/^[01]/.test(local.slice(3))) {
    return `1${local}`;
  }
  if (base.startsWith('+') && !base.startsWith('+1') && digits.length >= 8 && digits.length <= 15) {
    return digits.replace(/^0+/, '');
  }
  return null;
}

/**
 * A person's name. Reps write notes into the name fields - "(FACTURATION)
 * Mélissa", "Paul (comptable)" - and a note folded into the name ("facturation
 * melissa") matches nobody, so anything in parentheses goes first.
 */
function personName(v: string | null | undefined): string | null {
  return lettersOnly(v ? v.replace(/\([^)]*\)/g, ' ') : v);
}

export const normFirstName = personName;
export const normLastName = personName;

/**
 * A city. "St-Jean-sur-Richelieu" and "Saint-Jean-sur-Richelieu" are one place
 * with one spelling on Meta's side, so St / Ste are written out; a note in
 * parentheses or after a comma ("Lévis (Québec)", "Laval, QC") is dropped
 * rather than glued onto the name.
 */
export function normCity(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = fold(v.replace(/\([^)]*\)/g, ' ').split(',')[0])
    .replace(/\bste\b\.?/g, 'sainte')
    .replace(/\bst\b\.?/g, 'saint');
  return lettersOnly(s);
}

/** Provinces and territories by every spelling found in the CRM, to Meta's form. */
const PROVINCES: Record<string, string> = {
  qc: 'quebec', pq: 'quebec', quebec: 'quebec', que: 'quebec',
  on: 'ontario', ont: 'ontario', ontario: 'ontario',
  nb: 'newbrunswick', newbrunswick: 'newbrunswick', nouveaubrunswick: 'newbrunswick',
  ns: 'novascotia', novascotia: 'novascotia', nouvelleecosse: 'novascotia',
  pe: 'princeedwardisland', pei: 'princeedwardisland', princeedwardisland: 'princeedwardisland',
  ileduprinceedouard: 'princeedwardisland',
  nl: 'newfoundlandandlabrador', newfoundlandandlabrador: 'newfoundlandandlabrador',
  terreneuveetlabrador: 'newfoundlandandlabrador',
  mb: 'manitoba', manitoba: 'manitoba',
  sk: 'saskatchewan', saskatchewan: 'saskatchewan',
  ab: 'alberta', alberta: 'alberta',
  bc: 'britishcolumbia', britishcolumbia: 'britishcolumbia', colombiebritannique: 'britishcolumbia',
  yt: 'yukon', yukon: 'yukon',
  nt: 'northwestterritories', northwestterritories: 'northwestterritories',
  territoiresdunordouest: 'northwestterritories',
  nu: 'nunavut', nunavut: 'nunavut',
};

/**
 * A Canadian province by name or code, as Meta's full lowercase name. Anything
 * else is dropped: the column also holds city names ("Montréal") and regions,
 * and a wrong state would only hurt a match.
 */
export function normProvince(v: string | null | undefined): string | null {
  const s = lettersOnly(v);
  return s ? (PROVINCES[s] ?? null) : null;
}

const COUNTRIES: Record<string, string> = {
  ca: 'ca', can: 'ca', cad: 'ca', canada: 'ca', canda: 'ca', quebec: 'ca',
  us: 'us', usa: 'us', unitedstates: 'us', etatsunis: 'us', unitedstatesofamerica: 'us',
  fr: 'fr', france: 'fr',
};

/**
 * The country, as a two-letter code. An empty country is Canada: half the
 * accounts leave it blank, and they are Quebec businesses. A country that is
 * filled in but not recognised is dropped rather than guessed.
 */
export function normCountry(v: string | null | undefined): string | null {
  const s = lettersOnly(v);
  if (!s) return 'ca';
  return COUNTRIES[s] ?? null;
}

/** "G1V 4M6" → "g1v4m6"; "12345-6789" → "12345". Other shapes are dropped. */
export function normZip(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = fold(v).replace(/[^a-z0-9]/g, '');
  if (/^[a-z]\d[a-z]\d[a-z]\d$/.test(s)) return s;
  if (/^\d{5}(\d{4})?$/.test(s)) return s.slice(0, 5);
  return null;
}

export const SCHEMA = ['EMAIL', 'PHONE', 'FN', 'LN', 'CT', 'ST', 'ZIP', 'COUNTRY'] as const;

export type ContactInput = {
  email: string | null;
  secondary_email: string | null;
  phone: string | null;
  mobile: string | null;
  first_name: string | null;
  last_name: string | null;
  mail_city: string | null;
  mail_state: string | null;
  mail_code: string | null;
  mail_country: string | null;
};

/**
 * One contact as rows of plain (unhashed, normalised) values in SCHEMA order,
 * or [] when there is neither an email nor a phone to match on.
 *
 * A row holds one email and one phone, so a contact with two of either becomes
 * two rows sharing the name and address: the first email with the mobile (the
 * number that belongs to the person), the second with the desk phone. Names and
 * an address alone are not sent - for a business contact the address is the
 * company's, and a name at a company address matches the wrong people.
 */
export function contactRows(c: ContactInput): string[][] {
  const emails = [...new Set([normEmail(c.email), normEmail(c.secondary_email)].filter((v): v is string => !!v))];
  const phones = [...new Set([normPhone(c.mobile), normPhone(c.phone)].filter((v): v is string => !!v))];
  const n = Math.max(emails.length, phones.length);
  if (n === 0) return [];

  const country = normCountry(c.mail_country);
  const shared = [
    normFirstName(c.first_name) ?? '',
    normLastName(c.last_name) ?? '',
    normCity(c.mail_city) ?? '',
    // A province is only meaningful in Canada.
    country === 'ca' ? (normProvince(c.mail_state) ?? '') : '',
    normZip(c.mail_code) ?? '',
    country ?? '',
  ];
  const rows: string[][] = [];
  for (let i = 0; i < n; i++) rows.push([emails[i] ?? '', phones[i] ?? '', ...shared]);
  return rows;
}

/**
 * SHA-256 as lowercase hex. Empty stays empty.
 *
 * Synchronous on purpose. WebCrypto's digest is one async operation per value,
 * and the largest audience hashes ~50,000 distinct values: measured at about a
 * second of CPU that way, a quarter of that with createHash. Supabase stops a
 * function at 2 s of CPU, mid-upload if that is where it is.
 */
export function sha256Hex(v: string): string {
  return v ? createHash('sha256').update(v, 'utf8').digest('hex') : '';
}
