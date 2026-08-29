/**
 * Every external paid call is recorded here with its units and a price. Rates
 * are stamped at call time so a tour's cost can always be reconstructed. Where a
 * provider does not return the exact charge we estimate from its public rate
 * card and mark the entry estimated.
 */
import fs from "node:fs/promises";

export interface LedgerEntry {
  ts: string;
  stage: string;
  provider: "fal" | "openai" | "wikimedia" | "mock";
  endpoint: string;
  note: string;
  units: number;
  unitType: string;
  rateUsd: number;
  costUsd: number;
  estimated: boolean;
  ms: number;
  output?: string;
  error?: string;
}

export class Ledger {
  entries: LedgerEntry[] = [];

  constructor(private file?: string) {}

  static async load(file: string): Promise<Ledger> {
    const l = new Ledger(file);
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as { entries?: LedgerEntry[] };
      l.entries = raw.entries ?? [];
    } catch {
      l.entries = [];
    }
    return l;
  }

  async add(entry: Omit<LedgerEntry, "ts" | "costUsd"> & { costUsd?: number }): Promise<LedgerEntry> {
    const full: LedgerEntry = {
      ...entry,
      ts: new Date().toISOString(),
      costUsd: entry.costUsd ?? round(entry.units * entry.rateUsd),
    };
    this.entries.push(full);
    if (this.file) await this.save();
    return full;
  }

  /** Re-read entries written by other processes sharing this file, keeping ours. */
  private async merge(): Promise<void> {
    if (!this.file) return;
    try {
      const onDisk = (JSON.parse(await fs.readFile(this.file, "utf8")) as { entries?: LedgerEntry[] }).entries ?? [];
      const seen = new Set(this.entries.map((e) => e.ts + e.endpoint + e.note));
      for (const e of onDisk) if (!seen.has(e.ts + e.endpoint + e.note)) this.entries.push(e);
      this.entries.sort((a, b) => a.ts.localeCompare(b.ts));
    } catch {
      // no file yet
    }
  }

  total(): number {
    return round(this.entries.reduce((s, e) => s + (e.error ? 0 : e.costUsd), 0));
  }

  byProvider(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) if (!e.error) out[e.provider] = round((out[e.provider] ?? 0) + e.costUsd);
    return out;
  }

  modelsUsed(): string[] {
    return [...new Set(this.entries.filter((e) => !e.error && e.provider !== "wikimedia").map((e) => e.endpoint))];
  }

  async save(): Promise<void> {
    if (!this.file) return;
    await this.merge();
    await fs.writeFile(this.file, JSON.stringify({ totalUsd: this.total(), byProvider: this.byProvider(), entries: this.entries }, null, 2));
  }
}

export function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Wraps a call so timing, errors and cost land in the ledger whatever happens.
 * Providers do not return the exact charge, so everything metered here is an
 * estimate from the public rate card.
 */
export async function metered<T>(
  ledger: Ledger,
  meta: Omit<LedgerEntry, "ts" | "costUsd" | "ms" | "units" | "unitType" | "rateUsd" | "output" | "error" | "estimated">,
  fn: () => Promise<{ result: T; units: number; unitType: string; rateUsd: number; costUsd?: number; output?: string }>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    await ledger.add({ ...meta, estimated: true, ms: Date.now() - t0, units: r.units, unitType: r.unitType, rateUsd: r.rateUsd, costUsd: r.costUsd, output: r.output });
    return r.result;
  } catch (err) {
    await ledger.add({ ...meta, estimated: true, ms: Date.now() - t0, units: 0, unitType: "none", rateUsd: 0, costUsd: 0, error: (err as Error).message.slice(0, 300) });
    throw err;
  }
}
