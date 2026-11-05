"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MandateCard, mandateStatus } from "@/components/agent-console-mandate";
import { ToolChip, type ChipState } from "@/components/agent-console-chip";
import { Button, Eyebrow, Field, Panel, cx, inputClass } from "@/components/ui";
import { thrownText } from "@/lib/api-client";
import { SERVER_LABEL, TOKEN_STORAGE_PREFIX, type ApprovalLink, type ConsoleEvent, type ConsoleMessage, type MandateSummary, type ToolServer } from "@/lib/agent/protocol";

type Turn =
  | { role: "user"; text: string }
  | { role: "agent"; text: string | null; notice?: string | null; chips: ChipState[]; error: string | null; thinking: number | null; pending: boolean };

const STARTERS = ["What needs my attention?", "Approve the milestone in review if the policy already decided release", "Show this month's PayPal transactions"];

function readToken(id: string): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_PREFIX + id) ?? "";
  } catch {
    return "";
  }
}

function writeToken(id: string, token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_PREFIX + id, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_PREFIX + id);
  } catch {
    // storage blocked: the token lives in this page's state only
  }
}

/** The browser's history for the next turn: texts, and each agent turn's tool calls as one line apiece. */
function history(turns: Turn[]): ConsoleMessage[] {
  return turns.flatMap((t): ConsoleMessage[] => {
    if (t.role === "user") return [{ role: "user", text: t.text }];
    if (t.pending || (!t.text && !t.chips.length)) return [];
    const calls = t.chips.map((c) => `${SERVER_LABEL[c.server]} · ${c.tool} → ${c.result?.summary ?? "no result"}`);
    return [{ role: "agent", text: t.text ?? t.error ?? "", ...(calls.length ? { calls } : {}) }];
  });
}

function openLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

export interface AgentConsoleProps {
  mandates: MandateSummary[];
  initialMandateId: string | null;
  now: number;
  modelReady: boolean;
  modelLabel: string;
  clientName: string;
}

/**
 * The client's agent, in conversation. Each turn posts to /api/agents/console, which runs the agent loop server side
 * under the selected mandate and streams every MCP tool call back as it happens.
 */
export function AgentConsole({ mandates, initialMandateId, now, modelReady, modelLabel, clientName }: AgentConsoleProps) {
  const usable = useMemo(() => mandates.filter((m) => mandateStatus(m, now) === "active"), [mandates, now]);
  const [mandateId, setMandateId] = useState(initialMandateId && usable.some((m) => m.id === initialMandateId) ? initialMandateId : (usable[0]?.id ?? ""));
  const mandate = mandates.find((m) => m.id === mandateId) ?? null;
  const [token, setToken] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<{ tools: Array<{ server: ToolServer; name: string }>; notes: string[]; model: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  // The token for the selected mandate, if this tab created it (or it was pasted before).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after mount
    if (mandateId) setToken(readToken(mandateId));
  }, [mandateId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns]);

  useEffect(() => () => abort.current?.abort(), []);

  const links: ApprovalLink[] = turns.flatMap((t) => (t.role === "agent" ? t.chips.flatMap((c) => c.result?.links ?? []) : []));
  const lastLink = links[links.length - 1] ?? null;

  function patchAgent(fn: (t: Extract<Turn, { role: "agent" }>) => Extract<Turn, { role: "agent" }>) {
    setTurns((prev) => {
      const i = prev.length - 1;
      const last = prev[i];
      if (!last || last.role !== "agent") return prev;
      const next = prev.slice();
      next[i] = fn(last);
      return next;
    });
  }

  function apply(e: ConsoleEvent) {
    if (e.t === "start") setServers({ tools: e.tools, notes: e.notes, model: e.model });
    else if (e.t === "thinking") patchAgent((t) => ({ ...t, thinking: e.turn }));
    else if (e.t === "call") patchAgent((t) => ({ ...t, thinking: null, chips: [...t.chips, { id: e.id, server: e.server, tool: e.tool, args: e.args }] }));
    else if (e.t === "result") patchAgent((t) => ({ ...t, chips: t.chips.map((c) => (c.id === e.id ? { ...c, result: { ok: e.ok, summary: e.summary, status: e.status, links: e.links } } : c)) }));
    else if (e.t === "reply") patchAgent((t) => ({ ...t, text: e.text, notice: e.notice ?? null, thinking: null }));
    else if (e.t === "error") patchAgent((t) => ({ ...t, error: e.error, thinking: null }));
    else if (e.t === "done") patchAgent((t) => ({ ...t, pending: false, thinking: null }));
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !mandate) return;
    if (!token.trim()) {
      setTurns((prev) => [...prev, { role: "agent", text: null, chips: [], error: "Paste this mandate's token first (it was shown once when the mandate was created).", thinking: null, pending: false }]);
      return;
    }
    const next: Turn[] = [...turns, { role: "user", text: message }];
    setTurns([...next, { role: "agent", text: null, chips: [], error: null, thinking: 0, pending: true }]);
    setDraft("");
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await fetch("/api/agents/console", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandateId: mandate.id, token: token.trim(), messages: history(next).slice(-16) }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
        const reason = typeof body?.reason === "string" ? ` (${body.reason})` : "";
        apply({ t: "error", error: `${typeof body?.error === "string" ? body.error : `request failed (${res.status})`}${reason}` });
        apply({ t: "done" });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            apply(JSON.parse(line) as ConsoleEvent);
          } catch {
            // a malformed line is skipped
          }
        }
      }
      apply({ t: "done" });
    } catch (err) {
      if (!ctl.signal.aborted) apply({ t: "error", error: thrownText(err) });
      apply({ t: "done" });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  const agentName = mandate?.agentName ?? "Agent";
  const disabled = !modelReady || !mandate;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:h-[612px] lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* The conversation */}
      <Panel padded={false} className="flex min-h-[520px] flex-col lg:min-h-0" aria-label="Conversation">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
          <p className="min-w-0 truncate font-mono text-[11px] text-fg-faint">
            <span className="text-fg-muted">{agentName}</span> for {clientName}
            <span className="hidden sm:inline"> · {servers?.model ?? modelLabel}</span>
          </p>
          <p className="shrink-0 font-mono text-[11px] text-fg-faint">{servers ? `${servers.tools.length} tools` : "tools load on first message"}</p>
        </div>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-5" aria-live="polite">
          {turns.length === 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
              <p className="max-w-[56ch] text-fg-muted">
                Ask {agentName} to check on your contracts, approve a release the policy already decided, or look up a PayPal transaction. Every tool call it makes shows here, with what came back.
              </p>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <Button key={s} variant="secondary" size="sm" className="h-auto! min-h-8 max-w-full whitespace-normal! py-1.5 text-left" disabled={disabled || busy} onClick={() => void send(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="grid grid-cols-[minmax(0,1fr)] gap-5">
              {turns.map((t, i) => (
                <li key={i} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[88px_minmax(0,1fr)] sm:gap-4">
                  <p className="type-label pt-1 text-fg-faint">{t.role === "user" ? "You" : "Agent"}</p>
                  {t.role === "user" ? (
                    <p className="whitespace-pre-wrap text-fg">{t.text}</p>
                  ) : (
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                      {t.chips.map((c) => (
                        <ToolChip key={c.id} chip={c} />
                      ))}
                      {t.thinking !== null && t.pending ? (
                        <p className="flex items-center gap-2 font-mono text-[12px] text-fg-faint">
                          <span aria-hidden className="size-[7px] animate-pulse-dot rounded-full bg-fg-faint" />
                          {t.thinking === 0 && t.chips.length === 0 ? "Connecting to Milestone MCP and the model…" : "Thinking…"}
                        </p>
                      ) : null}
                      {t.text ? <p className="whitespace-pre-wrap text-fg">{t.text}</p> : null}
                      {t.notice ? <p className="font-mono text-[12px] text-[color:var(--ink-needs)]">{t.notice}</p> : null}
                      {t.error ? <p className="text-[13px] text-state-danger">{t.error}</p> : null}
                      {t.chips.some((c) => c.result?.links.length) ? (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {t.chips.flatMap((c) => c.result?.links ?? []).map((l) => (
                            <Button key={l.url} variant="secondary" size="sm" onClick={() => openLink(l.url)}>
                              {l.label}
                            </Button>
                          ))}
                          <span className="self-center font-mono text-[11px] text-fg-faint">You approve the payment; the agent cannot.</span>
                        </div>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        <form onSubmit={onSubmit} className="flex items-end gap-3 border-t border-hairline px-5 py-4">
          <label htmlFor="agent-console-input" className="sr-only">
            Message {agentName}
          </label>
          <textarea
            id="agent-console-input"
            rows={1}
            className={cx(inputClass, "max-h-32 min-h-10 resize-none")}
            placeholder={!modelReady ? "No model configured: set ANTHROPIC_API_KEY" : !mandate ? "Create a mandate first" : `Message ${agentName}`}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          {busy ? (
            <Button variant="ghost" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={disabled || !draft.trim()}>
              Send
            </Button>
          )}
        </form>
      </Panel>

      {/* The mandate */}
      <Panel as="aside" className="flex flex-col gap-5 lg:min-h-0 lg:overflow-y-auto" aria-label="Mandate">
        {mandate ? (
          <MandateCard m={mandate} now={now} />
        ) : (
          <div>
            <Eyebrow>Mandate</Eyebrow>
            <p className="mt-2 text-fg-muted">No active mandate. Create one on the Agents page.</p>
            <div className="mt-4">
              <Button variant="secondary" size="sm" href="/agents">
                Create a mandate
              </Button>
            </div>
          </div>
        )}
        {usable.length > 1 ? (
          <Field label="Acting under" htmlFor="agent-console-mandate">
            <select id="agent-console-mandate" className={inputClass} value={mandateId} disabled={busy} onChange={(e) => setMandateId(e.target.value)}>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.agentName} · {m.id}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {mandate ? (
          <Field label="Token" htmlFor="agent-console-token" hint={token ? "Kept in this tab only." : "Shown once at creation; the showcase seed prints one."}>
            <input
              id="agent-console-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className={cx(inputClass, "font-mono text-[13px]")}
              placeholder="msa_…"
              value={token}
              disabled={busy}
              onChange={(e) => {
                setToken(e.target.value);
                writeToken(mandate.id, e.target.value.trim());
              }}
            />
          </Field>
        ) : null}
        <div className="mt-auto grid gap-2 border-t border-hairline pt-4 font-mono text-[11px] leading-4 text-fg-faint">
          {(["milestone", "paypal"] as const).map((srv) => {
            const names = servers?.tools.filter((t) => t.server === srv).map((t) => t.name) ?? [];
            const idle = srv === "milestone" ? "as this mandate" : "list_transactions, read-only";
            return (
              <p key={srv} className="truncate" title={names.join(", ") || undefined}>
                <span className="text-fg-muted">{SERVER_LABEL[srv]}</span> · {!servers ? idle : names.length === 0 ? "not connected" : srv === "paypal" ? `${names.join(", ")}, read-only` : `${names.length} tools as this mandate`}
              </p>
            );
          })}
          {servers?.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
          {lastLink ? (
            <div className="pt-2">
              <Button variant="secondary" size="sm" onClick={() => openLink(lastLink.url)}>
                {lastLink.label}
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
