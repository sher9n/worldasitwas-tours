/**
 * Live companion: builds the period character's instructions and mints a
 * short-lived OpenAI Realtime client secret so the phone can connect directly
 * over WebRTC. The persona prompt, dossier and guardrails never leave here.
 */
import type { Tour, Stop, Card } from "@timetravel/schema";
import { stripCitations } from "@timetravel/schema";

export interface SessionRequest {
  travellerId: string;
  stopId?: string;
  cardId?: string;
  locale?: string;
}

export interface SessionResponse {
  sessionId: string;
  expiresAt: string;
  realtime: {
    provider: "openai";
    model: string;
    voice: string;
    clientSecret: string;
    connectUrl: string;
  };
  limits: { maxMinutes: number; maxTurns: number };
}

export const COMPANION_TOOLS = [
  {
    type: "function",
    name: "show_card",
    description:
      "Bring a specific card of the tour onto the traveller's screen while you talk about it. Use it when you say things like 'let me show you' or when the traveller asks to see something that is on another card of this stop.",
    parameters: {
      type: "object",
      properties: { cardId: { type: "string", description: "The id of a card in the current tour." } },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "end_conversation",
    description: "Call this after you have said goodbye and the traveller clearly wants to stop talking.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function describeCard(card: Card): string {
  const parts: string[] = [`[${card.id}] ${card.kind}`];
  if (card.caption) parts.push(`caption: ${card.caption}`);
  if (card.kind === "text") parts.push(`text: ${card.text}`);
  if (card.kind === "archive") parts.push(`real archive item: ${card.credit.title} (${card.credit.holder})`);
  if (card.kind === "thenNow") parts.push("a then-and-now slider of the same viewpoint, this year against the present day");
  if (card.claims.length) parts.push("facts: " + card.claims.map((c) => `${c.text} (${c.confidence})`).join("; "));
  return parts.join(" | ");
}

function describeStop(stop: Stop): string {
  return [`STOP ${stop.order}: ${stop.title} (${stop.id})`, `You say on arrival: "${stop.arrival.line.text}"`, ...stop.cards.map(describeCard)].join("\n");
}

export function buildInstructions(tour: Tour, companionNotes: string | undefined, req: SessionRequest): string {
  const c = tour.companion;
  const stop = tour.stops.find((s) => s.id === req.stopId) ?? tour.stops[0];
  const sources = tour.sources.map((s) => `- ${s.title}`).join("\n");
  return `You are ${c.name}, ${c.role}, in ${tour.city === "london" ? "London" : tour.city} in the year ${tour.year}. You are a real person of your time speaking with a visitor who has, impossibly, arrived from the future. You never break character except for the safety rule below.

WHO YOU ARE
${stripCitations(c.bio)}

${companionNotes ? `NOTES ON HOW YOU SPEAK AND WHAT YOU KNOW\n${companionNotes}\n` : ""}
HOW TO TALK
- You are the tour's host and narrator: the warmth and momentum of the finest broadcast presenter of a guided walk, yet entirely a person of ${tour.year}. Vocabulary, measures and ideas of your time only; no modern idiom. Short sentences, concrete detail, humour; always hand the listener forward to what comes next. Do not narrate lists; talk like a person.
- No pet names as a habit: an endearment such as "love" at most once in a whole conversation, ideally never.
- Keep answers to two to four sentences unless asked for more. Lead with what you can see, hear or smell from where you are standing, then the fact.
- Prices, wages and distances in the money and measures of your time. If the visitor asks for a modern comparison, say you would not know but they can look it up.
- You know nothing after ${tour.yearRange[1]}. If asked about later events, people or inventions, say plainly that you have never heard of such a thing, in character, and stay curious.
- Distinguish what you know from what you suppose. When you are guessing, say so out loud in your own words ("I could not swear to it, but...").
- Never claim to be a real named historical person. You are ${c.name}, a person built from the records of people like you.
- The visitor can see pictures. Some are reconstructions, some are real pictures of your time. If a card is described as a real archive item, you may say it is a real picture.

THE TOUR YOU ARE GIVING
Title: ${tour.title}
${tour.summary}
The traveller is currently at ${stop.title}${req.cardId ? `, looking at card ${req.cardId}` : ""}. You will receive a message whenever the card on their screen changes; treat that as what you both are looking at now. Do not respond to those context messages unless spoken to.

${tour.stops.map(describeStop).join("\n\n")}

TOOLS
- show_card(cardId): use when you want the visitor to look at a particular card of this stop.
- end_conversation: use after you have said goodbye.

SOURCES YOUR KNOWLEDGE COMES FROM
${sources}

SAFETY
If the visitor talks about harming themselves or others, a medical emergency, or asks for anything dangerous, step out of character briefly, say you are a voice in a history app, suggest they contact local emergency services or someone they trust, then offer to continue the walk. Do not give medical, legal or financial advice as fact.`;
}

export async function mintSession(opts: {
  apiKey: string;
  model: string;
  tour: Tour;
  companionNotes?: string;
  request: SessionRequest;
  fetchImpl?: typeof fetch;
}): Promise<SessionResponse> {
  const f = opts.fetchImpl ?? fetch;
  const instructions = buildInstructions(opts.tour, opts.companionNotes, opts.request);
  const voice = opts.tour.companion.voice.voice;
  const body = {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model: opts.model,
      instructions,
      // She answers in text, and the player speaks it in the very voice the tour
      // is recorded in. Letting the model speak would answer a question in a
      // different person's voice from the one telling the story.
      output_modalities: ["text"],
      audio: {
        input: {
          // Push-to-talk: the client commits turns; no server voice activity detection.
          turn_detection: null,
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: { voice },
      },
      tools: COMPANION_TOOLS,
      tool_choice: "auto",
    },
  };
  const res = await f("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openai client_secrets ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { value: string; expires_at: number; session?: { id?: string } };
  return {
    sessionId: json.session?.id ?? `cs_${Math.random().toString(36).slice(2, 10)}`,
    expiresAt: new Date(json.expires_at * 1000).toISOString(),
    realtime: {
      provider: "openai",
      model: opts.model,
      voice,
      clientSecret: json.value,
      connectUrl: "https://api.openai.com/v1/realtime/calls",
    },
    limits: { maxMinutes: 15, maxTurns: 60 },
  };
}
