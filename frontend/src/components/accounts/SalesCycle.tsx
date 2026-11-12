import { ArrowRight } from 'lucide-react';
import type { ZohoSalesCycle } from '../../types/database';
import { InfoHint } from '../InfoHint';
import { isCohortOpen } from '../advertising/channel';
import { formatLongDate } from '../../lib/utils';

/** "7 jours", "1 jour": French takes the singular below two. */
function days(n: number): string {
    const r = Math.round(n);
    return `${r.toLocaleString('fr-CA')} jour${r >= 2 ? 's' : ''}`;
}

function count(n: number): string {
    return n.toLocaleString('fr-CA');
}

/** The French plural mark: none below two. */
function plural(n: number): string {
    return n >= 2 ? 's' : '';
}

/**
 * Lead received, quote accepted, invoice paid: the median delay of each step for
 * the leads received in the period. Its own cohort (leads by arrival date), not
 * the accounts created that the cards above count, so it says so in its heading.
 */
export function SalesCycle({ data, periodLabel, windowMonths }: {
    data: ZohoSalesCycle;
    /** "en 2026", "en septembre 2026", "depuis le début". */
    periodLabel: string;
    /** The page's revenue window; null is no cap. */
    windowMonths: number | null;
}) {
    const open = isCohortOpen(data.window_ends_on);
    const wonRate = data.leads_received > 0
        ? Math.round((data.leads_won / data.leads_received) * 100)
        : 0;
    const awaiting = data.leads_won - data.leads_paid - data.leads_paid_undated;
    const windowText = windowMonths === null
        ? 'à n’importe quel moment après le lead'
        : `dans les ${windowMonths} mois suivant le lead`;

    const hint =
        `Les leads reçus ${periodLabel} dans Zoho CRM et convertis en compte (un lead jamais converti n'a pas de compte à suivre). ` +
        `Devis accepté : le premier devis gagné de ce compte, accepté le jour du lead ou après, ${windowText}. ` +
        `Facture payée : la première facture émise après ce devis, payée en entier, à la date du paiement dans Zoho Books. ` +
        `La médiane est le délai du lead du milieu : la moitié a été plus rapide, l'autre plus lente. ` +
        `Chaque délai est calculé sur les leads qui ont atteint l'étape ; pour une période récente, les plus lents n'y sont pas encore. ` +
        `Les filtres de la page s'appliquent au compte du lead, et filtré sur un service, seuls les devis et factures de ce service comptent.`;

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm font-semibold text-ink">Du lead au paiement</h3>
                <InfoHint text={hint} />
                <p className="w-full md:w-auto md:ml-auto text-2xs text-ink-mute" translate="no">
                    <span className="font-bold text-ink-secondary tabular-nums">{count(data.leads_received)}</span>
                    {` lead${plural(data.leads_received)} reçu${plural(data.leads_received)} ${periodLabel} · délais médians`}
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-hairline" translate="no">
                <Step
                    from="Lead" to="Devis accepté"
                    value={data.median_days_to_won}
                    detail={data.leads_won > 0
                        ? `${count(data.leads_won)} lead${plural(data.leads_won)} sur ${count(data.leads_received)} (${wonRate} %) · moyenne ${days(data.avg_days_to_won ?? 0)}`
                        : 'Aucun devis accepté'}
                />
                <Step
                    from="Devis accepté" to="Facture payée"
                    value={data.median_days_won_to_paid}
                    detail={data.leads_paid > 0
                        ? `${count(data.leads_paid)} payée${plural(data.leads_paid)} sur ${count(data.leads_won)}` +
                          (awaiting > 0 ? `, ${count(awaiting)} en attente` : '') +
                          ` · moyenne ${days(data.avg_days_won_to_paid ?? 0)}`
                        : 'Aucune facture payée'}
                />
                <Step
                    from="Lead" to="Facture payée"
                    value={data.median_days_to_paid}
                    detail={data.leads_paid > 0
                        ? `Cycle complet, lead par lead · moyenne ${days(data.avg_days_to_paid ?? 0)}`
                        : 'Aucun cycle complet'}
                />
            </div>

            {(open || data.leads_paid_undated > 0) && (
                <div className="px-5 py-3 border-t border-hairline bg-sand/60 space-y-1 text-2xs text-ink-mute" translate="no">
                    {open && data.window_ends_on && (
                        <p className="text-tone-warn-ink font-medium">
                            Période encore ouverte : des leads peuvent signer jusqu’au {formatLongDate(data.window_ends_on)}, les délais peuvent donc encore s’allonger.
                        </p>
                    )}
                    {data.leads_paid_undated > 0 && (
                        <p>
                            {count(data.leads_paid_undated)} facture{plural(data.leads_paid_undated)} payée{plural(data.leads_paid_undated)} sans
                            date de paiement (réglée{plural(data.leads_paid_undated)} par un avoir, ou pas encore
                            relue{plural(data.leads_paid_undated)} dans Zoho Books) :
                            hors des délais ci-dessus.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

function Step({ from, to, value, detail }: {
    from: string;
    to: string;
    value: number | null;
    detail: string;
}) {
    return (
        <div className="px-5 py-4">
            <p className="flex items-center gap-1.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                {from}
                <ArrowRight className="w-3 h-3 text-ink-faint shrink-0" aria-label="puis" />
                {to}
            </p>
            <p className="mt-1 text-xl md:text-2xl font-bold text-ink tabular-nums">
                {value === null ? '—' : days(value)}
            </p>
            <p className="text-2xs text-ink-mute mt-0.5 font-medium italic">{detail}</p>
        </div>
    );
}
