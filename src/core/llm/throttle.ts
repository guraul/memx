let lastRunAt = 0;

export function shouldRun(throttleMinutes = 10): boolean {
  return Date.now() - lastRunAt >= throttleMinutes * 60_000;
}

export function markRun(): void {
  lastRunAt = Date.now();
}

export function resetThrottle(): void {
  lastRunAt = 0;
}
