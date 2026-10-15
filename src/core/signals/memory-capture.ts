import type { MemorySignal } from "../memory-types.ts";
import { MemorySignalSchema } from "../memory-types.ts";

const MAX_BUFFER_SIZE = 20;

const MEMORY_SIGNAL_RE = /<!--\s*MEMORY_SIGNAL:\s*(\{.+?\})\s*-->/;

export function captureMemorySignals(aiMessage: string): MemorySignal[] {
  const signals: MemorySignal[] = [];
  let match: RegExpExecArray | null;

  const re = new RegExp(MEMORY_SIGNAL_RE.source, "g");
  while ((match = re.exec(aiMessage)) !== null) {
    try {
      const raw = match[1]!;
      const parsed = JSON.parse(raw);
      const result = MemorySignalSchema.safeParse(parsed);
      if (result.success) {
        signals.push(result.data);
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return signals;
}

export class MemorySignalBuffer {
  private signals: MemorySignal[] = [];

  push(signal: MemorySignal): void {
    if (this.signals.some((s) => s.evidence === signal.evidence)) return;
    if (this.signals.length >= MAX_BUFFER_SIZE) {
      this.signals.shift();
    }
    this.signals.push(signal);
  }

  pushAll(newSignals: MemorySignal[]): void {
    for (const s of newSignals) {
      this.push(s);
    }
  }

  getAll(): MemorySignal[] {
    return [...this.signals];
  }

  clear(): void {
    this.signals = [];
  }

  get length(): number {
    return this.signals.length;
  }
}
