import { useEffect, useState } from "react";

/**
 * Returns elapsed seconds since `startMs` (epoch milliseconds).
 * When `isActive` is true, ticks every 100ms for a live timer.
 * When `isActive` is false, returns a static snapshot (no interval).
 */
export function useElapsedTimer(startMs: number, isActive: boolean): number {
	const [elapsed, setElapsed] = useState(() => (Date.now() - startMs) / 1000);

	useEffect(() => {
		if (!isActive) return;
		const tick = () => setElapsed((Date.now() - startMs) / 1000);
		tick();
		const id = setInterval(tick, 100);
		return () => clearInterval(id);
	}, [startMs, isActive]);

	// For inactive timers, compute once on startMs change without triggering re-renders via effect
	useEffect(() => {
		if (isActive) return;
		setElapsed((Date.now() - startMs) / 1000);
	}, [startMs, isActive]);

	return elapsed;
}
