import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js';
import { Logo } from '../components/Logo';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { clearPendingConsent } from '../lib/oauthConsent';

/**
 * Consent page of Supabase Auth's OAuth server: Claude asks to read the
 * database on the signed-in user's behalf (supabase/functions/mcp).
 *
 * Only a user whose allowed_users row has can_use_claude is offered the
 * choice; anyone else is refused here, before a token exists. The mcp function
 * checks the same flag on every request, so this page is the courtesy and the
 * function is the lock.
 */
type State =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    /** canDeny: the request is open, so Claude can be told it was refused. */
    | { kind: 'not_enabled'; canDeny: boolean }
    | { kind: 'ask'; details: OAuthAuthorizationDetails }
    | { kind: 'leaving' };

const EXPIRED = 'Cette demande a expiré ou a déjà été traitée. Recommencez la connexion depuis Claude.';

export default function OAuthConsent() {
    const [params] = useSearchParams();
    const authorizationId = params.get('authorization_id');
    const { user, signOut } = useAuth();
    const email = user?.email ?? null;
    const [state, setState] = useState<State>({ kind: 'loading' });
    // Reading the request ties it to this user and can answer with a redirect
    // that works once, so it is read once per request, StrictMode included.
    const loadedFor = useRef<string | null>(null);

    useEffect(() => { clearPendingConsent(); }, []);

    const load = useCallback(async () => {
        if (!authorizationId || !email) return;
        setState({ kind: 'loading' });

        const { data: row, error: rowError } = await supabase
            .from('allowed_users')
            .select('can_use_claude')
            .eq('email', email)
            .maybeSingle();
        if (rowError) {
            setState({ kind: 'error', message: 'Vos accès n’ont pas pu être vérifiés. Réessayez.' });
            return;
        }
        const enabled = (row as { can_use_claude?: boolean } | null)?.can_use_claude === true;

        // Opened even for a refusal: Auth only accepts a decision on a request
        // this user has read.
        const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
        if (error || !data) {
            setState({ kind: 'error', message: EXPIRED });
            return;
        }
        if (!enabled) {
            setState({ kind: 'not_enabled', canDeny: 'authorization_id' in data });
            return;
        }
        // Already approved once: Auth answers with the way back straight away.
        if ('redirect_url' in data) {
            setState({ kind: 'leaving' });
            window.location.assign(data.redirect_url);
            return;
        }
        setState({ kind: 'ask', details: data });
    }, [authorizationId, email]);

    useEffect(() => {
        const key = `${authorizationId}|${email}`;
        if (loadedFor.current === key) return;
        loadedFor.current = key;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        load();
    }, [load, authorizationId, email]);

    const decide = async (approve: boolean) => {
        if (!authorizationId) return;
        setState({ kind: 'leaving' });
        const { data, error } = approve
            ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
            : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
        if (error || !data) {
            setState({ kind: 'error', message: EXPIRED });
            return;
        }
        window.location.assign(data.redirect_url);
    };

    let body: React.ReactNode;
    if (!authorizationId) {
        body = <Message title="Lien incomplet" text="Il manque l’identifiant de la demande. Recommencez la connexion depuis Claude." />;
    } else if (state.kind === 'loading' || state.kind === 'leaving') {
        body = (
            <div className="flex justify-center py-6">
                <Loader2 className="w-6 h-6 animate-spin text-ink-mute" />
            </div>
        );
    } else if (state.kind === 'error') {
        body = (
            <>
                <Message title="Connexion impossible" text={state.message} />
                <a href="/" className="btn btn-md btn-secondary w-full mt-6">Ouvrir l’application</a>
            </>
        );
    } else if (state.kind === 'not_enabled') {
        body = (
            <>
                <Message
                    title="Claude n’est pas activé pour vous"
                    text={'Votre compte ne peut pas encore connecter Claude aux données d’Affichez. Demandez à un administrateur.'
                        + (state.canDeny ? '' : ' Vous pouvez fermer cette fenêtre.')}
                />
                {state.canDeny && (
                    <button onClick={() => decide(false)} className="btn btn-md btn-secondary w-full mt-6">
                        Retourner à Claude
                    </button>
                )}
            </>
        );
    } else {
        const { details } = state;
        let returnHost = details.redirect_uri;
        try { returnHost = new URL(details.redirect_uri).host; } catch { /* keep the raw value */ }
        body = (
            <>
                <h1 className="text-xl font-semibold text-ink tracking-tight">Connecter {details.client.name}</h1>
                <p className="text-sm text-ink-mute mt-2 leading-relaxed">
                    {details.client.name} demande à lire les données de ventes d’Affichez en votre nom.
                    L’accès est en lecture seulement : rien ne peut être modifié.
                </p>

                <dl className="mt-5 text-xs bg-sand rounded-md px-3 py-2 space-y-1">
                    <div className="flex justify-between gap-3">
                        <dt className="text-ink-mute">Compte</dt>
                        <dd className="text-ink-secondary truncate" translate="no">{email}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                        <dt className="text-ink-mute">Retour vers</dt>
                        <dd className="text-ink-secondary truncate" translate="no">{returnHost}</dd>
                    </div>
                </dl>

                <div className="mt-6 flex flex-col gap-2">
                    <button onClick={() => decide(true)} className="btn btn-md btn-primary w-full">
                        Autoriser
                    </button>
                    <button onClick={() => decide(false)} className="btn btn-md btn-secondary w-full">
                        Refuser
                    </button>
                </div>
            </>
        );
    }

    return (
        <div className="min-h-screen bg-sand flex items-center justify-center p-4">
            <div className="w-full max-w-sm">
                <div className="flex justify-center mb-8">
                    <Logo height={28} />
                </div>
                <div className="bg-white rounded-xl shadow-card p-8">{body}</div>
                <p className="text-center text-xs text-ink-faint mt-6">
                    Pas vous ?{' '}
                    <button onClick={signOut} className="underline underline-offset-2 hover:text-ink">Se déconnecter</button>
                </p>
            </div>
        </div>
    );
}

function Message({ title, text }: { title: string; text: string }) {
    return (
        <>
            <h1 className="text-xl font-semibold text-ink tracking-tight">{title}</h1>
            <p className="text-sm text-ink-mute mt-2 leading-relaxed">{text}</p>
        </>
    );
}
