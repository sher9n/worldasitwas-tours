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
      <table>
        <colgroup>
          <col className="c-when" /><col className="c-walk" /><col className="c-q" />
          <col className="c-a" /><col className="c-chars" /><col className="c-tokens" />
        </colgroup>
        <thead>
          <tr>
            <th>When (IST)</th>
            <th>Walk</th>
            <th>They asked</th>
            <th>The guide said</th>
            <th className="c-num">Chars</th>
            <th className="c-num">Tokens in/out</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((t, i) => (
            <tr key={`${t.sessionId}-${i}`} className={open === i ? "open" : ""} onClick={() => setOpen(open === i ? null : i)}>
              <td className="c-when">{ist.format(new Date(t.ts))}</td>
              <td className="c-walk">{walkName(t.tour)}</td>
              <td className="c-q">{t.question || <em>unintelligible</em>}</td>
              <td className="c-a">{open === i ? t.answer : t.answer.length > 160 ? `${t.answer.slice(0, 160)}…` : t.answer}</td>
              <td className="c-num">{t.qChars}/{t.aChars}</td>
              <td className="c-num">
                {t.usage?.input_tokens ?? "–"}/{t.usage?.output_tokens ?? "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="chats-note">A row is one completed ask. Click a row for the full answer. Turns are reported by the player when the answer finishes, so an ask with no entry here is an ask whose answer never completed.</p>
    </div>
  );
}
