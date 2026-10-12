import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Download, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

export type ExportChoice = {
    key: string;
    label: string;
    /** One line under the label saying what the file holds. */
    hint?: string;
    /** Builds and downloads the file; the menu shows the wait. */
    run: () => Promise<void>;
};

/**
 * "Exporter" with a choice of files - ExportButton's sibling for a table that
 * can be exported more than one way.
 *
 * The button keeps ExportButton's look so the toolbar does not change shape;
 * the menu hangs from its right edge, because it sits at the right of the page
 * header and a left-anchored menu would run off a narrow screen.
 */
export function ExportMenu({ choices, label, disabled, className }: {
    choices: ExportChoice[];
    label: string;
    disabled?: boolean;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const close = useCallback(() => setOpen(false), []);

    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!open || !menu) return;
        if (menu.getBoundingClientRect().left < 8) {
            menu.style.right = 'auto';
            menu.style.left = '0';
        }
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, close]);

    const run = async (choice: ExportChoice) => {
        if (busy) return;
        close();
        setBusy(choice.key);
        setError(null);
        try {
            await choice.run();
        } catch (err) {
            console.error('export failed', err);
            setError('L’export a échoué. Réessayez.');
            // It sits over the filter bar; it goes on its own after a while.
            setTimeout(() => setError(null), 8000);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div ref={ref} className={cn('relative', className)}>
            <button
                type="button"
                onClick={() => { setError(null); setOpen(o => !o); }}
                disabled={disabled || busy !== null}
                aria-haspopup="menu"
                aria-expanded={open}
                title="Télécharger ces données en CSV (ouvre dans Excel)"
                className="btn btn-xs btn-quiet"
            >
                {busy
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Download className="w-3.5 h-3.5" />}
                {/* translate="no": the label carries a live row count; see ExportButton. */}
                <span translate="no">{busy ? 'Préparation…' : label}</span>
                <ChevronDown className={cn('w-3 h-3 transition-transform duration-150', open && 'rotate-180')} />
            </button>

            {open && (
                <div
                    ref={menuRef}
                    role="menu"
                    className="absolute z-50 top-full mt-1.5 right-0 w-72 max-w-[calc(100vw-1rem)]
                               bg-white rounded-lg border border-hairline shadow-xl overflow-hidden py-1 menu-in"
                >
                    {choices.map(c => (
                        <button
                            key={c.key}
                            type="button"
                            role="menuitem"
                            onClick={() => run(c)}
                            className="w-full text-left px-3.5 py-2.5 hover:bg-sand transition-colors"
                        >
                            <span className="block text-sm font-semibold text-ink" translate="no">{c.label}</span>
                            {c.hint && <span className="block text-xs text-ink-mute mt-0.5">{c.hint}</span>}
                        </button>
                    ))}
                </div>
            )}

            {error && (
                <p role="alert" className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-tone-critical-ink">
                    {error}
                </p>
            )}
        </div>
    );
}
