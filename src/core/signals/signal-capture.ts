import type { StyleSignal } from "../types.ts";
import { StyleSignalSchema } from "../types.ts";

const MAX_BUFFER_SIZE = 20;

const STYLE_SIGNAL_RE = /<!--\s*STYLE_SIGNAL:\s*(\{.+?\})\s*-->/;

export function captureSignals(_userMessage: string, aiMessage: string): StyleSignal[] {
  return parseStyleSignalComments(aiMessage);
}

function parseStyleSignalComments(aiMessage: string): StyleSignal[] {
  const signals: StyleSignal[] = [];
  let match: RegExpExecArray | null;

  const re = new RegExp(STYLE_SIGNAL_RE.source, "g");
  while ((match = re.exec(aiMessage)) !== null) {
    try {
      const raw = match[1]!;
      const parsed = JSON.parse(raw);
      const result = StyleSignalSchema.safeParse(parsed);
      if (result.success) {
        signals.push(result.data);
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return signals;
}

export class SignalBuffer {
  private signals: StyleSignal[] = [];

  push(signal: StyleSignal): void {
    if (this.signals.some((s) => s.evidence === signal.evidence)) return;
    if (this.signals.length >= MAX_BUFFER_SIZE) {
      this.signals.shift();
    }
    this.signals.push(signal);
  }

  pushAll(newSignals: StyleSignal[]): void {
    for (const s of newSignals) {
      this.push(s);
    }
  }

  getAll(): StyleSignal[] {
    return [...this.signals];
  }

  clear(): void {
    this.signals = [];
  }

  get length(): number {
    return this.signals.length;
  }
}
