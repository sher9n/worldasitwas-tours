/**
 * Research and writing run on OpenAI's Responses API (gpt-5.4), with the web
 * search tool for research and JSON schema structured outputs so every stage
 * hands the next one a validated shape.
 */
import OpenAI from "openai";
import type { ZodSchema } from "zod";
import type { Ledger } from "./ledger.ts";
import { metered } from "./ledger.ts";
import { RATES } from "./prices.ts";

export interface StructuredCall<T> {
  name: string;
  jsonSchema: Record<string, unknown>;
  zod: ZodSchema<T>;
  system: string;
  user: string;
  webSearch?: boolean;
  effort?: "low" | "medium" | "high";
  stage: string;
  note: string;
}

export class Llm {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
    private ledger: Ledger,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    this.client = new OpenAI({ apiKey });
  }

  async structured<T>(call: StructuredCall<T>): Promise<T> {
    return metered(this.ledger, { stage: call.stage, provider: "openai", endpoint: this.model, note: call.note }, async () => {
      const tools = call.webSearch ? [{ type: "web_search" as const }] : undefined;
      const req: Record<string, unknown> = {
        model: this.model,
        input: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        text: { format: { type: "json_schema", name: call.name, schema: call.jsonSchema, strict: true } },
        reasoning: { effort: call.effort ?? "medium" },
      };
      if (tools) req.tools = tools;
      let res;
      try {
        res = await this.client.responses.create(req as never);
      } catch (err) {
        // Older accounts expose the search tool under its preview name.
        const msg = (err as Error).message || "";
        if (tools && /web_search/.test(msg)) {
          req.tools = [{ type: "web_search_preview" }];
          res = await this.client.responses.create(req as never);
        } else throw err;
      }
      const r = res as unknown as { output_text: string; usage?: { input_tokens: number; output_tokens: number } };
      const text = r.output_text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`model returned non-JSON for ${call.name}: ${text.slice(0, 200)}`);
      }
      const result = call.zod.parse(parsed);
      const inTok = r.usage?.input_tokens ?? 0;
      const outTok = r.usage?.output_tokens ?? 0;
      return {
        result,
        units: inTok + outTok,
        unitType: "tokens",
        rateUsd: 0,
        costUsd: inTok * RATES.gpt54.inputPerTok + outTok * RATES.gpt54.outputPerTok,
        output: `in=${inTok} out=${outTok}`,
      };
    });
  }
}
