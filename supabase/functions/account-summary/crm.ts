// The card's temperature and figures copied onto the Zoho CRM account, so list
// views, filters, reports and a Kanban view can use them. Written with the
// summary token after every summary, without triggering workflows. The values
// are those of the latest card; the account's own history in Zoho records each
// change.

import type { Temperature } from './prompt.ts';
import { crmUpdate } from './zoho.ts';

/** API names of the custom fields on Accounts. An empty name leaves that value out. */
const FIELDS = {
  temperature: 'Temp_rature_IA',
  reason: 'Raison_de_la_temp_rature_IA',
  next_step: 'Prochaine_tape_IA',
  summarized_at: 'Date_du_r_sum_IA',
  open_quotes: 'Devis_ouverts_IA',
  overdue: 'Factures_en_retard_IA',
} as const;

/** The picklist options of the temperature field, exactly as created in Zoho. */
const TEMPERATURE_OPTION: Record<Temperature, string> = {
  a_risque: 'À risque',
  chaud: 'Chaud',
  client_actif: 'Client actif',
  tiede: 'Tiède',
  dormant: 'Dormant',
  froid: 'Froid',
};

const TEXT_MAX = 255;

/** The parts of a stored card the fields are filled from. */
export interface CardFields {
  temperature: Temperature;
  temperature_reason: string;
  next_steps: Array<{ title: string }>;
  stats: { open_quotes: { total: number }; overdue: { total: number } };
}

function text(value: string | null | undefined): string | null {
  const t = (value ?? '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t) : null;
}

/** Zoho's datetime format: seconds, and an explicit offset rather than "Z". */
function zohoDateTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19)}+00:00`;
}

/** The Accounts fields a card sets, keyed by API name. */
export function accountFields(card: CardFields, writtenAt: string): Record<string, unknown> {
  const values: Record<keyof typeof FIELDS, unknown> = {
    temperature: TEMPERATURE_OPTION[card.temperature] ?? null,
    reason: text(card.temperature_reason),
    next_step: text(card.next_steps?.[0]?.title),
    summarized_at: zohoDateTime(writtenAt),
    // Zero rather than empty, so "equal to 0" matches an account with none.
    open_quotes: card.stats?.open_quotes?.total ?? 0,
    overdue: card.stats?.overdue?.total ?? 0,
  };
  const data: Record<string, unknown> = {};
  for (const [key, api] of Object.entries(FIELDS)) if (api) data[api] = values[key as keyof typeof FIELDS];
  return data;
}

export async function writeAccountFields(accountId: string, card: CardFields, writtenAt: string): Promise<void> {
  await crmUpdate('Accounts', accountId, accountFields(card, writtenAt));
}
