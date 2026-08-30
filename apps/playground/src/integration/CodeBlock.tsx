/**
 * A copyable code slab.
 *
 * Everything on the Integrate and Embed tabs is meant to be taken away and
 * pasted, so the copy button is the point and the highlighting is only there
 * to keep a 60-line file readable. The tokeniser is deliberately tiny and
 * renders through React elements rather than innerHTML: the snippets are built
 * from live tour ids and titles, and nothing that came out of a manifest
 * should ever reach the DOM as markup.
 */
import { useCallback, useMemo, useState } from "react";

export type Lang = "ts" | "tsx" | "sh" | "json" | "env";

type TokenKind = "comment" | "string" | "keyword" | "number" | "plain";

const KEYWORDS = new Set([
  "import", "from", "export", "default", "const", "let", "var", "function", "return", "if", "else",
  "await", "async", "new", "type", "interface", "extends", "implements", "class", "for", "while",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "null", "undefined", "true", "false",
  "void", "as", "in", "of", "case", "switch", "break", "continue", "readonly", "public", "private",
]);

/**
 * One pass, longest-match-first. Comments and strings are matched before
 * identifiers so a keyword inside a comment stays a comment.
 */
const TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function tokenize(code: string, lang: Lang): { kind: TokenKind; text: string }[] {
  // Shell and env files have no keyword vocabulary worth colouring — only
  // comments and quoted values, which the same regex already finds.
  const wordsAreKeywords = lang === "ts" || lang === "tsx";
  const out: { kind: TokenKind; text: string }[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "plain", text: code.slice(last, at) });
    const [full, comment, str, num, word] = m;
    if (comment) out.push({ kind: "comment", text: full });
    else if (str) out.push({ kind: "string", text: full });
    else if (num) out.push({ kind: "number", text: full });
    else if (word && wordsAreKeywords && KEYWORDS.has(word)) out.push({ kind: "keyword", text: full });
    else out.push({ kind: "plain", text: full });
    last = at + full.length;
  }
  if (last < code.length) out.push({ kind: "plain", text: code.slice(last) });
  return out;
}

export function CodeBlock({
  code,
  lang = "ts",
  file,
  note,
}: {
  code: string;
  lang?: Lang;
  /** Where this belongs in the developer's repo. Shown as the slab's header. */
  file?: string;
  /** One line under the header saying what it is for. */
  note?: string;
}) {
  const [copied, setCopied] = useState(false);
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);

  const copy = useCallback(() => {
    // A playground served over plain HTTP on a LAN address has no clipboard
    // API, and the button must not simply do nothing there.
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, fallback);
    } else fallback();

    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } finally {
        ta.remove();
      }
    }
  }, [code]);

  return (
    <figure className="code">
      <figcaption>
        <span className="code-file">{file ?? lang}</span>
        <button type="button" onClick={copy} className={copied ? "copied" : ""}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      {note && <p className="code-note">{note}</p>}
      <pre>
        <code>
          {tokens.map((t, i) => (t.kind === "plain" ? t.text : <span key={i} className={`tk-${t.kind}`}>{t.text}</span>))}
        </code>
      </pre>
    </figure>
  );
}
