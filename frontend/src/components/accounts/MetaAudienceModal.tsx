import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, ExternalLink, Download, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { downloadCsv, type CsvColumn } from '../../lib/csv';
import { cn } from '../../lib/utils';
import { ChannelLogoTile } from '../advertising/ChannelLogo';
import type { AccountContactExportRow, ZohoAccountRow } from '../../types/database';
import { fetchAccountContacts, refusedMarketing } from './accountContacts';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/meta-custom-audience`;

type MetaStatus = {
    configured: boolean;
    ad_account: { id: string; name: string | null } | null;
    has_permission: boolean | null;
    terms_accepted: boolean | null;
    terms_url: string | null;
    /** Blocks sending. */
    problem: string | null;
    /** Shown, does not block (the create call is the real test). */
    warning: string | null;
};

type CreateResult = {
    /** False when the audience exists but its record in the app could not be completed. */
    log_saved: boolean;
    customer_file_source: 'USER_PROVIDED_ONLY' | 'BOTH_USER_AND_PARTNER_PROVIDED';
    audience_id: string;
    name: string;
    ad_account_id: string;
    audience_url: string;
    accounts: number;
    contacts: number;
    contacts_sent: number;
    rows_sent: number;
    num_received: number;
    num_invalid_entries: number;
    sent_ids: string[];
    opted_out_ids: string[];
    unreachable_ids: string[];
};

/** Calls the function with the signed-in user's own token: it refuses anything else. */
async function callAudienceFn<T>(body: object): Promise<T> {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(FN_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${session?.access_token ?? ''}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    let payload: Record<string, unknown> = {};
    try { payload = await res.json(); } catch { /* non-JSON error page */ }
    if (res.status === 403) throw new Error('Vous n’avez pas accès à la création d’audiences (sections Comptes et Publicité requises).');
    if (!res.ok) throw new Error(String(payload.error ?? `Erreur ${res.status}`));
    return payload as T;
}

const hasText = (v: string | null) => !!v && v.trim() !== '';
const reachable = (c: AccountContactExportRow) =>
    hasText(c.email) || hasText(c.secondary_email) || hasText(c.phone) || hasText(c.mobile);
/** A refusal flag not known yet: counted as a refusal, see refusedMarketing. */
const statusUnknown = (c: AccountContactExportRow) => c.email_opt_out === null || c.no_marketing === null;

type Phase = 'loading' | 'ready' | 'sending' | 'done';

/**
 * "Créer une audience Meta" for the accounts currently filtered on Comptes ·
 * Détail: a name, one choice about marketing refusals, and a summary of who
 * will be sent before anything leaves.
 *
 * The browser sends only the account ids. The function reads the contacts
 * itself, with the caller's token, normalises and hashes them, and uploads.
 * The counts shown before sending are the browser's estimate from the same
 * rows; the report after sending is built from what the function says it did.
 */
export function MetaAudienceModal({ loadAccounts, filters, defaultName, onClose }: {
    loadAccounts: () => Promise<ZohoAccountRow[]>;
    /** The page's filters, stored with the audience so it can be described and rebuilt later. */
    filters: Record<string, string[]>;
    defaultName: string;
    onClose: () => void;
}) {
    const [phase, setPhase] = useState<Phase>('loading');
    const [status, setStatus] = useState<MetaStatus | null>(null);
    const [accounts, setAccounts] = useState<ZohoAccountRow[]>([]);
    const [contacts, setContacts] = useState<AccountContactExportRow[]>([]);
    const [name, setName] = useState(defaultName);
    const [description, setDescription] = useState('');
    const [excludeRefused, setExcludeRefused] = useState(true);
    // Two kinds of error: a failed load leaves nothing to send, a failed send
    // can be retried after changing the name or the option, so it must not lock
    // the button.
    const [loadError, setLoadError] = useState<string | null>(null);
    const [sendError, setSendError] = useState<string | null>(null);
    const [result, setResult] = useState<CreateResult | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [st, accts] = await Promise.all([
                    callAudienceFn<MetaStatus>({ action: 'status' }),
                    loadAccounts(),
                ]);
                const cts = await fetchAccountContacts(accts.map(a => a.zoho_account_id));
                if (cancelled) return;
                setStatus(st);
                setAccounts(accts);
                setContacts(cts);
                setPhase('ready');
            } catch (e) {
                if (cancelled) return;
                setLoadError(e instanceof Error ? e.message : String(e));
                setPhase('ready');
            }
        })();
        return () => { cancelled = true; };
    }, [loadAccounts]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'sending') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, phase]);

    // The backdrop closes the dialog only for a click that started on it: a text
    // selection dragged out of the name field must not close it. And never once
    // the audience is made, when the report is still to be downloaded.
    const pressedOnBackdrop = useRef(false);

    const summary = useMemo(() => {
        const withReach = contacts.filter(reachable);
        const refused = contacts.filter(c => refusedMarketing(c));
        const unknown = contacts.filter(statusUnknown);
        const toSend = withReach.filter(c => !excludeRefused || !refusedMarketing(c));
        return {
            contacts: contacts.length,
            withEmail: contacts.filter(c => hasText(c.email) || hasText(c.secondary_email)).length,
            withPhone: contacts.filter(c => hasText(c.phone) || hasText(c.mobile)).length,
            refused: refused.length,
            unknown: unknown.length,
            toSend: toSend.length,
        };
    }, [contacts, excludeRefused]);

    const ready = status !== null && status.problem === null;
    const canSend = phase === 'ready' && ready && name.trim() !== '' && summary.toSend > 0 && !loadError;

    const send = async () => {
        if (!canSend) return;
        setPhase('sending');
        setSendError(null);
        try {
            const r = await callAudienceFn<CreateResult>({
                action: 'create',
                name: name.trim(),
                description: description.trim() || undefined,
                account_ids: accounts.map(a => a.zoho_account_id),
                exclude_opted_out: excludeRefused,
                filters,
            });
            setResult(r);
            setPhase('done');
        } catch (e) {
            setSendError(e instanceof Error ? e.message : String(e));
            setPhase('ready');
        }
    };

    const downloadReport = () => {
        if (!result) return;
        const accountName = new Map(accounts.map(a => [a.zoho_account_id, a.account_name]));
        const sent = new Set(result.sent_ids);
        const optedOut = new Set(result.opted_out_ids);
        const statusOf = (c: AccountContactExportRow) =>
            sent.has(c.zoho_record_id) ? 'Envoyé'
            : optedOut.has(c.zoho_record_id)
                ? (statusUnknown(c) && !(c.email_opt_out || c.no_marketing)
                    ? 'Exclu : statut d’abonnement inconnu'
                    : 'Exclu : refuse le marketing')
            : 'Exclu : ni courriel ni téléphone utilisable';
        const cols: CsvColumn<AccountContactExportRow>[] = [
            { header: 'Statut',      value: statusOf },
            { header: 'Compte',      value: c => accountName.get(c.account_id) ?? null },
            { header: 'Prénom',      value: c => c.first_name },
            { header: 'Nom',         value: c => c.last_name },
            { header: 'Courriel',    value: c => c.email },
            { header: 'Courriel secondaire', value: c => c.secondary_email },
            { header: 'Cellulaire',  value: c => c.mobile },
            { header: 'Téléphone',   value: c => c.phone },
            { header: 'Ville',       value: c => c.mail_city },
            { header: 'Code postal', value: c => c.mail_code },
            { header: 'Lien CRM',    value: c => c.zoho_crm_url },
        ];
        const slug = result.name.replace(/[^\w-]+/g, '_').slice(0, 40);
        downloadCsv(contacts, cols, `audience_meta_${slug}`);
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
            onMouseDown={e => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
            onClick={e => {
                if (e.target === e.currentTarget && pressedOnBackdrop.current
                    && phase !== 'sending' && phase !== 'done') onClose();
            }}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Créer une audience personnalisée Meta"
                onClick={e => e.stopPropagation()}
                className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <ChannelLogoTile channel="meta" />
                        <div className="min-w-0">
                            <h2 className="text-lg font-semibold text-ink">Créer une audience Meta</h2>
                            <p className="text-xs text-ink-mute truncate">
                                {status?.ad_account
                                    ? `Compte publicitaire ${status.ad_account.name ?? status.ad_account.id}`
                                    : 'Audience personnalisée à partir d’une liste de clients'}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={phase === 'sending'}
                        aria-label="Fermer"
                        className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-stone hover:text-ink-secondary disabled:opacity-40"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="overflow-y-auto px-6 py-5 space-y-5">
                    {phase === 'loading' && (
                        <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-mute">
                            <Loader2 className="h-5 w-5 animate-spin text-primary-press" />
                            Lecture des contacts et vérification de Meta…
                        </div>
                    )}

                    {phase === 'done' && result && (
                        <div className="space-y-4">
                            <div className="flex items-start gap-3 rounded-lg bg-tone-good-soft px-4 py-3">
                                <CheckCircle2 className="h-5 w-5 shrink-0 text-tone-good-ink mt-0.5" />
                                <div className="text-sm text-tone-good-ink">
                                    <p className="font-semibold">Audience « {result.name} » créée.</p>
                                    <p className="mt-0.5 text-xs">
                                        Meta la remplit en arrière-plan : la taille estimée apparaît dans le
                                        Gestionnaire de publicités, en général en moins d’une heure (jusqu’à 24 h).
                                    </p>
                                </div>
                            </div>
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" translate="no">
                                <Stat label="Comptes" value={result.accounts} />
                                <Stat label="Contacts envoyés" value={result.contacts_sent} sub={`sur ${result.contacts.toLocaleString('fr-CA')}`} />
                                <Stat label="Lignes reçues par Meta" value={result.num_received} />
                                <Stat label="Lignes invalides" value={result.num_invalid_entries} />
                            </dl>
                            <div className="flex flex-wrap gap-2">
                                <a href={result.audience_url} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-dark">
                                    <ExternalLink className="h-4 w-4" />
                                    Ouvrir dans Meta
                                </a>
                                <button type="button" onClick={downloadReport} className="btn btn-sm btn-secondary">
                                    <Download className="h-4 w-4" />
                                    Rapport (CSV)
                                </button>
                            </div>
                            <p className="text-xs text-ink-mute">
                                Le rapport liste chaque contact avec son statut (envoyé ou exclu, et pourquoi).
                                Il n’est pas conservé tel quel : téléchargez-le maintenant si vous en avez besoin.
                            </p>
                            {result.customer_file_source === 'BOTH_USER_AND_PARTNER_PROVIDED' && (
                                <p className="text-xs text-ink-mute">
                                    Une partie de ces comptes vient d’une liste de clients rachetée (Royer &amp; Fils,
                                    PLOGG/BUCCO) : la liste a été déclarée à Meta comme fournie en partie par un partenaire.
                                </p>
                            )}
                            {!result.log_saved && (
                                <p role="alert" className="rounded-lg bg-tone-warn-soft px-4 py-3 text-xs text-tone-warn-ink">
                                    L’audience est créée, mais son enregistrement dans l’application n’a pas pu être
                                    complété. Téléchargez le rapport : c’est la seule trace de qui a été envoyé.
                                </p>
                            )}
                        </div>
                    )}

                    {(phase === 'ready' || phase === 'sending') && (
                        <>
                            {status?.problem && (
                                <div className="flex items-start gap-3 rounded-lg bg-tone-warn-soft px-4 py-3 text-sm text-tone-warn-ink">
                                    <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                        <p className="font-semibold">Meta n’est pas prêt pour les audiences.</p>
                                        <p className="text-xs">{status.problem}</p>
                                    </div>
                                </div>
                            )}
                            {!status?.problem && status?.warning && (
                                <div className="flex items-start gap-3 rounded-lg bg-tone-warn-soft px-4 py-3 text-sm text-tone-warn-ink">
                                    <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                        <p className="text-xs">{status.warning}</p>
                                        {status.terms_url && (
                                            <a href={status.terms_url} target="_blank" rel="noopener noreferrer" className="link text-xs inline-flex items-center gap-1">
                                                Page d’acceptation des conditions (administrateur du compte publicitaire)
                                                <ExternalLink className="h-3 w-3" />
                                            </a>
                                        )}
                                    </div>
                                </div>
                            )}

                            {status && (
                                <div className="rounded-lg bg-sand px-4 py-3" translate="no">
                                    <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow mb-2">Avec les filtres actuels</p>
                                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                        <Stat label="Comptes" value={accounts.length} />
                                        <Stat label="Contacts" value={summary.contacts} />
                                        <Stat label="Avec courriel" value={summary.withEmail} />
                                        <Stat label="Avec téléphone" value={summary.withPhone} />
                                    </dl>
                                </div>
                            )}

                            <label className="block">
                                <span className="block text-sm font-semibold text-ink mb-1">Nom de l’audience</span>
                                <input
                                    value={name}
                                    onChange={e => { setName(e.target.value); setSendError(null); }}
                                    maxLength={150}
                                    className="form-input"
                                    disabled={phase === 'sending'}
                                />
                                <span className="block text-xs text-ink-mute mt-1">
                                    Évitez toute mention de santé ou de situation financière : Meta bloque ces audiences.
                                </span>
                            </label>

                            <label className="block">
                                <span className="block text-sm font-semibold text-ink mb-1">
                                    Description <span className="font-normal text-ink-mute">(facultatif)</span>
                                </span>
                                <textarea
                                    value={description}
                                    onChange={e => setDescription(e.target.value)}
                                    maxLength={500}
                                    rows={2}
                                    className="form-input h-auto py-2 resize-none"
                                    disabled={phase === 'sending'}
                                />
                            </label>

                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={excludeRefused}
                                    onChange={e => { setExcludeRefused(e.target.checked); setSendError(null); }}
                                    disabled={phase === 'sending'}
                                    className="mt-0.5 h-4 w-4 accent-ink"
                                />
                                <span className="text-sm text-ink-secondary">
                                    Exclure les contacts qui refusent le marketing
                                    <span className="text-ink-mute tabular-nums" translate="no"> ({summary.refused.toLocaleString('fr-CA')})</span>
                                    <span className="block text-xs text-ink-mute mt-0.5">
                                        Désabonnés des courriels ou case « ne veut pas recevoir nos courriels marketing » cochée dans Zoho.
                                        {summary.unknown > 0 && (
                                            <> Le statut de {summary.unknown.toLocaleString('fr-CA')} contact{summary.unknown > 1 ? 's' : ''} n’est
                                            pas encore connu (synchronisation en attente) : cochée, l’option les exclut aussi.</>
                                        )}
                                    </span>
                                </span>
                            </label>

                            <p className="flex items-start gap-2 text-xs text-ink-mute">
                                <ShieldCheck className="h-4 w-4 shrink-0 text-ink-faint" />
                                Courriels, téléphones, noms et adresses sont normalisés puis hachés (SHA-256) avant
                                l’envoi : Meta ne reçoit aucune donnée lisible et l’utilise seulement pour retrouver
                                ces personnes.
                            </p>

                            {(loadError || sendError) && (
                                <p role="alert" className="rounded-lg bg-tone-critical-soft px-4 py-3 text-sm text-tone-critical-ink">
                                    {loadError ?? sendError}
                                </p>
                            )}
                        </>
                    )}
                </div>

                {(phase === 'ready' || phase === 'sending') && (
                    <div className="flex items-center justify-between gap-3 border-t border-hairline bg-sand/60 px-6 py-3">
                        <span className="text-sm text-ink-mute tabular-nums" translate="no">
                            {status && `${summary.toSend.toLocaleString('fr-CA')} contact${summary.toSend > 1 ? 's' : ''} à envoyer`}
                        </span>
                        <div className="flex items-center gap-2">
                            <button type="button" onClick={onClose} disabled={phase === 'sending'} className="btn btn-sm btn-ghost">
                                Annuler
                            </button>
                            <button type="button" onClick={send} disabled={!canSend} className={cn('btn btn-sm btn-primary')}>
                                {phase === 'sending' && <Loader2 className="h-4 w-4 animate-spin" />}
                                {phase === 'sending' ? 'Envoi à Meta…' : 'Créer l’audience'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
    return (
        <div>
            <dt className="text-xs text-ink-mute">{label}</dt>
            <dd className="font-bold text-ink tabular-nums">
                {value.toLocaleString('fr-CA')}
                {sub && <span className="ml-1 text-xs font-normal text-ink-mute">{sub}</span>}
            </dd>
        </div>
    );
}
