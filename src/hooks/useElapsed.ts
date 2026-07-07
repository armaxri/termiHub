import { useEffect, useRef, useState } from "react";

/**
 * Tracks the whole seconds elapsed since `active` last became `true`.
 *
 * While `active` is true the value ticks up once per second (starting at 0);
 * when `active` is false it resets to 0 and stops ticking. Each fresh activation
 * restarts the count from 0, so it is suitable for driving a "Connecting… (Ns)"
 * readout that must reset per connect attempt.
 *
 * @param active Whether the timer should be running.
 * @returns Whole seconds elapsed since activation (0 when inactive).
 */
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }

    startRef.current = Date.now();
    setElapsed(0);

    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);

    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}
