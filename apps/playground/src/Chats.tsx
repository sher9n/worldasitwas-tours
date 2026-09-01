/**
 * Every conversation travellers have had with the guides: the question, the
 * answer that was streamed back, and what it measured. Reached as the Chats
 * tab, or directly at /chats.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";

export interface ChatTurn {
  ts: string;
  tour: string;
  sessionId: string;
  travellerId: string;
  stopId?: string;
  question: string;
  answer: string;
  model?: string;
  qChars: number;
  aChars: number;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** All times shown in IST, and labelled so nobody has to guess. */
const ist = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Colombo",
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});
const walkName = (id: string) => id.replace(/^tour_/, "").replace(/_/g, " ");

export function Chats() {
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api.chats(300).then(
      (r) => setTurns(r.turns),
      (e) => setError(String((e as Error).message || e)),
    );
  }, []);

  if (error) return <div className="panel"><p className="empty">Could not load chats: {error}</p></div>;
  if (!turns) return <div className="panel"><p className="empty">Reading the ledger…</p></div>;
  if (turns.length === 0) {
    return (
      <div className="panel">
        <p className="empty">
          No conversations yet. When a traveller holds to ask and the guide answers, the whole
          exchange lands here: what was asked, what was said back, and what it measured.
        </p>
      </div>
    );
  }

  const tokens = turns.reduce((a, t) => a + (t.usage?.total_tokens ?? 0), 0);
  const sessions = new Set(turns.map((t) => t.sessionId)).size;

  return (
    <div className="panel chats">
      <div className="chats-sum">
        <span>{turns.length} turn{turns.length === 1 ? "" : "s"}</span>
        <span>{sessions} conversation{sessions === 1 ? "" : "s"}</span>
        <span>{tokens.toLocaleString()} tokens</span>
      </div>
      {/*
        A card per turn, not a table: this panel is about 600px wide, and six
        columns turn the answer into a one-word-per-line ribbon. Stacked, the
        question and the answer get the full width, which is what people came
        to read, and the measurements sit on one quiet line above them.
      */}
      <ol className="chats-list">
        {turns.map((t, i) => {
          const long = t.answer.length > 320;
          return (
            <li key={`${t.sessionId}-${i}`} className="c-turn">
              <div className="c-meta">
                <span className="c-when">{ist.format(new Date(t.ts))} IST</span>
                <span className="c-walk">{walkName(t.tour)}</span>
                {t.stopId && <span className="c-stop">{t.stopId.replace(/^stop_\d+_?/, "").replace(/_/g, " ")}</span>}
                <span className="c-num">{t.qChars}/{t.aChars} chars</span>
                <span className="c-num">
                  {t.usage?.input_tokens?.toLocaleString() ?? "–"} in / {t.usage?.output_tokens?.toLocaleString() ?? "–"} out tokens
                </span>
              </div>
              <p className="c-q">
                <span className="c-lab">They asked</span>
                {t.question || <em>nothing we could make out</em>}
              </p>
              <p className="c-a">
                <span className="c-lab">The guide said</span>
                {long && open !== i ? `${t.answer.slice(0, 320)}…` : t.answer}
                {long && (
                  <button className="c-more" onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? "less" : "the rest"}
                  </button>
                )}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="chats-note">One card is one completed ask. Turns are reported by the player when the answer finishes, so an ask with no card here is an ask whose answer never completed.</p>
    </div>
  );
}
