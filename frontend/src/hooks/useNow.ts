import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs`. Read it during render instead
 * of Date.now(), which makes the render impure; as a bonus an "il y a 3 min"
 * label keeps counting while nothing else on the page changes.
 */
export function useNow(intervalMs = 30_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}
