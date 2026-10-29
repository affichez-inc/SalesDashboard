import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Logo } from '../components/Logo';
import { Accented } from '../components/Accented';
import { rememberConsentRequest } from '../lib/oauthConsent';

const ZOHO_CLIENT_ID = import.meta.env.VITE_ZOHO_CLIENT_ID as string;
const SUPABASE_URL   = import.meta.env.VITE_SUPABASE_URL as string;
const REDIRECT_URI   = `${SUPABASE_URL}/functions/v1/zoho-auth`;

const ERROR_MESSAGES: Record<string, string> = {
    denied:         "Connexion annulée.",
    not_authorized: "Votre compte n'est pas autorisé. Contactez l'administrateur.",
    token_failed:   "Erreur d'authentification Zoho. Réessayez.",
    no_email:       "Impossible de récupérer votre courriel Zoho.",
    session_failed: "Erreur lors de la création de session. Réessayez.",
    server_error:   "Erreur serveur. Réessayez dans un moment.",
};

export default function Login() {
    const [loading, setLoading]  = useState(false);
    const [searchParams]         = useSearchParams();
    const authError              = searchParams.get('auth_error');

    useEffect(() => {
        if (authError) window.history.replaceState({}, '', window.location.pathname);
    }, [authError]);

    const handleZohoLogin = () => {
        setLoading(true);
        // zoho-auth returns to "/", whatever page the sign-in started from.
        rememberConsentRequest();
        const params = new URLSearchParams({
            client_id:     ZOHO_CLIENT_ID,
            response_type: 'code',
            scope:         'openid email profile',
            redirect_uri:  REDIRECT_URI,
            access_type:   'online',
            prompt:        'consent',
            state:         window.location.origin,
        });
        window.location.href = `https://accounts.zoho.com/oauth/v2/auth?${params}`;
    };

    return (
        // Sand ground, white card. Not the tempting black/white split - the
        // brand runs black edge to edge or not at all.
        <div className="min-h-screen bg-sand flex items-center justify-center p-4">
            <div className="w-full max-w-sm">

                <div className="flex justify-center mb-8">
                    <Logo height={28} />
                </div>

                <div className="bg-white rounded-xl shadow-card p-8">
                    <div className="mb-7">
                        <h1 className="text-2xl text-ink">
                            <Accented text="Bon *retour*." />
                        </h1>
                        <p className="text-sm text-ink-mute mt-1">Connectez-vous avec votre compte Zoho.</p>
                    </div>

                    {authError && (
                        <div className="mb-5 text-xs font-medium text-tone-critical-ink bg-tone-critical-soft border border-tone-critical/30 rounded-md px-4 py-3">
                            {ERROR_MESSAGES[authError] ?? "Une erreur est survenue. Réessayez."}
                        </div>
                    )}

                    {/* Black, not orange: the button carries Zoho's own four-colour
                        mark, and white-on-black is the only surface that mark reads
                        on. The orange on this screen is the wordmark. */}
                    <button
                        onClick={handleZohoLogin}
                        disabled={loading}
                        className="btn btn-dark btn-lg w-full gap-3"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ZohoIcon />}
                        {loading ? 'Redirection…' : 'Se connecter avec Zoho'}
                    </button>
                </div>

                <p className="text-center text-xs text-ink-faint mt-6">
                    {new Date().getFullYear()} Affichez · Usage interne seulement
                </p>
            </div>
        </div>
    );
}

function ZohoIcon() {
    // The mark's letterforms are already white in the file, so it needs no
    // blend mode on a black fill.
    return <img src="/zoho-logo.svg" alt="" className="h-5 w-auto" />;
}
