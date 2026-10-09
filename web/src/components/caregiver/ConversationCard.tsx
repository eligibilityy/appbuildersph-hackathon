"use client";

import { useState } from "react";
import { Cpu, MessageSquarePlus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ConversationResult } from "@/lib/api";

const SAMPLES = [
  { label: "English", text: "Hi Lola, it's Miguel, your grandson. I just started a new job in BGC." },
  {
    label: "Taglish",
    text: "Hi Lolo! Si Carlo po ito, apo niyo. Ikakasal na po ako sa Disyembre, doon sa simbahan sa Tagaytay.",
  },
  {
    label: "Tagalog",
    text: "Magandang hapon po, Lola. Ako po si Ana, apo ninyo. Galing po ako sa Baguio kahapon.",
  },
];

/** "Add a conversation": type or paste what someone said; the LLM on this laptop remembers it as a visit. */
export default function ConversationCard({ personId, onSaved }: { personId: number; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConversationResult | null>(null);

  async function remember() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.addConversation(personId, text);
      setResult(r);
      setText("");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remember this conversation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="conversation-title" className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="conversation-title" className="flex items-center gap-2 text-title">
          <MessageSquarePlus className="size-5 text-primary" /> Add a conversation
        </h3>
        <span className="inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
          <Cpu className="size-3.5" /> Remembered by the AI on this laptop
        </span>
      </div>
      <p className="mt-1 text-body text-muted-foreground">
        Type or paste what they said, in English, Taglish or Tagalog.
      </p>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."
        aria-label="What they said"
        className="mt-3"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-footnote text-muted-foreground">Try:</span>
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={busy}
            onClick={() => setText(s.text)}
            className="h-9 rounded-full border bg-background px-3.5 text-footnote font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
        <Button type="button" className="ml-auto" disabled={busy || !text.trim()} onClick={remember}>
          {busy ? "Remembering on this laptop…" : "Remember this"}
        </Button>
      </div>

      <div aria-live="polite">
        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-destructive/10 p-3 text-body text-destructive">
            {error}
          </p>
        )}
        {result && (
          <div className="mt-4 rounded-xl bg-muted p-4">
            {result.renamed && result.person.name && (
              <p className="mb-2 text-footnote font-semibold text-primary">
                Named from the conversation: {result.person.name}
                {result.person.relationship ? `, ${result.person.relationship}` : ""} (please confirm)
              </p>
            )}
            <p className="text-[17px] leading-6 font-semibold">{result.summary ?? "Nothing new worth remembering."}</p>
            {result.facts.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {result.facts.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-body">
                    <Sparkles className="mt-1 size-3.5 shrink-0 text-primary" /> {f}
                  </li>
                ))}
              </ul>
            )}
            {result.brief && (
              <p className="mt-3 text-body">
                <span className="text-footnote font-medium text-muted-foreground">Next time, the app will say: </span>
                “{result.brief}”
              </p>
            )}
            <p className="mt-2 text-footnote text-muted-foreground">
              Remembered on this laptop in {result.llm_seconds.toFixed(1)} s · {result.model}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
