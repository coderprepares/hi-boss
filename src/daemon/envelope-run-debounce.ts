import type { AgentRunTrigger } from "../agent/executor-triggers.js";

export const ENVELOPE_TRIGGER_DEBOUNCE_MS = 500;

export interface DebouncedEnvelopeRun {
  agentName: string;
  trigger: AgentRunTrigger;
}

export class EnvelopeRunDebouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly delayMs: number = ENVELOPE_TRIGGER_DEBOUNCE_MS) {}

  schedule(
    agentName: string,
    trigger: AgentRunTrigger,
    run: (task: DebouncedEnvelopeRun) => void
  ): void {
    const existing = this.timers.get(agentName);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(agentName);
      run({ agentName, trigger });
    }, this.delayMs);

    this.timers.set(agentName, timer);
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
