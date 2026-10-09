"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Cpu, MessageCircleQuestion, Volume2, WifiOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, AskResult } from "@/lib/api";
import { playSpeech } from "@/lib/audio";
import { initials } from "@/lib/format";
import { Person } from "@/lib/server";

/** True while the browser has no network at all (Wi-Fi off): proof the answer didn't come from the cloud. */
function useOffline() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline;
}

/**
 * "Ask about your people": a question in English, Taglish or Tagalog, answered by the LLM running on this
 * laptop from saved memories only, then spoken. Shows how long the local model took.
 */
export default function AskPanel({
  people,
  version,
  onOpenPerson,
}: {
  people: Person[];
  version: number;
  onOpenPerson: (p: Person) => void;
}) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offline = useOffline();

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const suggestions = useMemo(() => {
    const first = (p?: Person) => p?.name?.split(" ")[0];
    const [a, b] = [first(people[0]), first(people[1] ?? people[0])];
    return [
      a && `What's new with ${a}?`,
      "Who visited today?",
      b && `Ano'ng balita kay ${b}?`,
      a && `When did I last see ${a}?`,
    ].filter(Boolean) as string[];
  }, [people]);

  async function run(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setAsked(text);
    setResult(null);
    try {
      const r = await api.ask(text);
      setResult(r);
      if (r.audio_url) playSpeech(r.audio_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't get an answer.");
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    run(question);
  }

  return (
    <section aria-labelledby="ask-title" className="mb-8 rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ask-title" className="flex items-center gap-2 text-title">
          <MessageCircleQuestion className="size-5 text-primary" /> Ask about your people
        </h2>
        <span className="inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
          <Cpu className="size-3.5" /> Answered by the AI on this laptop
        </span>
      </div>

      {people.length === 0 ? (
        <p className="mt-3 text-body text-muted-foreground">Add someone first, then ask about them here.</p>
      ) : (
        <>
          <form onSubmit={submit} className="mt-4 flex gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What's new with Miguel? · Sino ang bumisita ngayon?"
              aria-label="Your question"
              maxLength={300}
              className="h-11 flex-1"
            />
            <Button type="submit" size="lg" disabled={busy || !question.trim()}>
              Ask
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => {
                  setQuestion(s);
                  run(s);
                }}
                className="h-9 rounded-full border bg-background px-3.5 text-footnote font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </>
      )}

      {(busy || result || error) && (
        <div className="mt-4 rounded-xl bg-muted p-4" aria-live="polite">
          {asked && <p className="text-footnote text-muted-foreground">“{asked}”</p>}
          {busy && (
            <div className="mt-2 flex flex-col gap-2" aria-label="Thinking on this laptop">
              <p className="text-body text-muted-foreground">Thinking on this laptop…</p>
              <Skeleton className="h-5 w-3/4" />
            </div>
          )}
          {error && (
            <p role="alert" className="mt-1 text-body text-destructive">
              {error}
            </p>
          )}
          {result && (
            <>
              <p className="mt-1 text-[20px] leading-7 font-semibold">{result.answer}</p>
              {result.person_ids.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {result.person_ids.map((id) => {
                    const p = byId.get(id);
                    if (!p) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onOpenPerson(p)}
                        className="inline-flex h-9 items-center gap-2 rounded-full border bg-card pr-3.5 pl-1 text-footnote font-medium outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <Avatar className="size-7">
                          <AvatarImage src={api.thumbUrl(id, version)} alt="" className="object-cover" />
                          <AvatarFallback className="bg-secondary text-[11px]">{initials(p.name)}</AvatarFallback>
                        </Avatar>
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-muted-foreground">
                {result.llm_seconds !== null && (
                  <span>
                    Answered on this laptop in {result.llm_seconds.toFixed(1)} s · {result.model}
                  </span>
                )}
                {result.audio_url && (
                  <button
                    type="button"
                    onClick={() => playSpeech(result.audio_url!)}
                    className="inline-flex items-center gap-1 font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <Volume2 className="size-3.5" /> Play again
                  </button>
                )}
                {offline && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-medium text-[#1f7a35]">
                    <WifiOff className="size-3.5" /> Wi-Fi off
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
