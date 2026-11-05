import type { Metadata } from "next";
import { AgentConsole } from "@/components/agent-console";
import { Button, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { loadMandates } from "@/lib/agent/data";
import { currentModel, isModelConfigured } from "@/lib/agent/model";
import { ACTOR_NAMES, getActor } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agent console" };

/** The client's agent in conversation, acting through Milestone MCP under one of the client's mandates. */
export default async function AgentConsolePage({ searchParams }: PageProps<"/agents/console">) {
  const sp = await searchParams;
  const actor = await getActor();
  const [mandates, modelReady] = await Promise.all([loadMandates(getDb(), actor.userId), isModelConfigured()]);
  const initial = typeof sp.mandate === "string" ? sp.mandate : null;
  return (
    <main>
      <PageHeader
        eyebrow={
          <>
            Agents · console <span className="hidden sm:inline">· Milestone MCP + PayPal MCP</span>
          </>
        }
        title="Agent console"
        actions={
          <Button variant="ghost" href="/agents">
            Mandates and audit
          </Button>
        }
      />
      <div className="mt-8">
        <AgentConsole
          mandates={mandates}
          initialMandateId={initial}
          now={new Date().getTime()}
          modelReady={modelReady}
          modelLabel={modelReady ? `Claude · ${currentModel()}` : "no model reachable"}
          clientName={ACTOR_NAMES[actor.userId] ?? actor.userId}
        />
      </div>
    </main>
  );
}
