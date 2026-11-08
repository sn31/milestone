import { buildAuthSchemes, type AuthSchemes } from "./auth-schemes.js";
import type { ClientOptions } from "./client-options.js";
import { buildCoreClientOptions } from "./core/client-options.js";
import { RawClient } from "./core/raw-client.js";
import * as host from "./core/runtime-environment.js";
import * as s from "./core/validation/index.js";
import { Advances } from "./resources/advances.js";
import { Agents } from "./resources/agents.js";
import { Contracts } from "./resources/contracts.js";
import { Deliveries } from "./resources/deliveries.js";
import { Demo } from "./resources/demo.js";
import { Dev } from "./resources/dev.js";
import { Disputes } from "./resources/disputes.js";
import { Milestones } from "./resources/milestones.js";
import { Ops } from "./resources/ops.js";
import { Paypal } from "./resources/paypal.js";
import { Vault } from "./resources/vault.js";
import { Webhooks } from "./resources/webhooks.js";
import { buildServers, type Servers } from "./servers.js";

/**
 * Scope: every route handler under apps/web/src/app/api as of Nov 5 2026 (34 files). The agent,
 * vault, dispute, status, reconcile and demo routes added after 0.2.0 are described at path,
 * method, parameter and status level; their response bodies are named in the descriptions rather
 * than fully modelled.
 *
 * Routes under apps/web/src/app/api. Authentication is a role cookie, `milestone_actor`, set by the
 * role switcher in the UI. Values: usr_client, usr_freelancer, usr_partner. A missing or unknown
 * cookie acts as the client. This is a hackathon stand-in for real sign-in. The two webhook routes
 * do not use the cookie; they verify a signature instead.
 *
 * Deliveries are created by the GitHub webhook (source github_pr), by /api/milestones/{id}/deliver
 * (manual) or by /api/milestones/{id}/upload (upload). Advances go through /api/advances/offer and
 * /api/advances/accept. The /api/dev/paypal/* routes exist only while PAYPAL_MODE=simulated and
 * answer 404 otherwise (mode answers always). Roles: usr_client, usr_freelancer and usr_partner act
 * on the demo contracts; the freelancer and client checks compare the cookie's user with the
 * contract's parties.
 *
 * Agents authenticate with `Authorization: Bearer msa_...` (a mandate token from POST /api/agents)
 * on /api/mcp and on /api/milestones/{id}/review. Mandate, saved-PayPal and operator routes refuse
 * any request with an Authorization header: those are for people. /api/demo/reset exists only with
 * DEMO_MODE=1.
 */
export class MilestoneApiClient {
  readonly #rawClient: RawClient;
  readonly #servers: Servers;
  readonly #auth: AuthSchemes;
  #contracts?: Contracts;
  #milestones?: Milestones;
  #paypal?: Paypal;
  #webhooks?: Webhooks;
  #deliveries?: Deliveries;
  #advances?: Advances;
  #ops?: Ops;
  #disputes?: Disputes;
  #agents?: Agents;
  #vault?: Vault;
  #demo?: Demo;
  #dev?: Dev;

  constructor(options: ClientOptions = {}) {
    this.#rawClient = new RawClient({
      ...buildCoreClientOptions(options, "MILESTONE_API_CLIENT_LOG"),
      defaultHeaders: [
        { name: "User-Agent", value: "MilestoneApiClient/0.3.0 TypeScript", schema: s.string() },
        { name: "X-APIMatic-Lang", value: "TypeScript", schema: s.string() },
        { name: "X-APIMatic-Package-Version", value: "0.3.0", schema: s.string() },
        { name: "X-APIMatic-Gen-Version", value: "4.0.0", schema: s.string() },
        { name: "X-APIMatic-OS", value: host.operatingSystem(), schema: s.optional(s.string()) },
        { name: "X-APIMatic-Runtime", value: host.runtimeDescription(), schema: s.optional(s.string()) },
      ],
      defaultQuery: [],
      defaultPathParams: [],
    });

    this.#servers = buildServers(options);

    this.#auth = buildAuthSchemes(options);
  }

  get contracts(): Contracts {
    return (this.#contracts ??= new Contracts(this.#rawClient, this.#servers, this.#auth));
  }

  get milestones(): Milestones {
    return (this.#milestones ??= new Milestones(this.#rawClient, this.#servers, this.#auth));
  }

  get paypal(): Paypal {
    return (this.#paypal ??= new Paypal(this.#rawClient, this.#servers, this.#auth));
  }

  get webhooks(): Webhooks {
    return (this.#webhooks ??= new Webhooks(this.#rawClient, this.#servers));
  }

  get deliveries(): Deliveries {
    return (this.#deliveries ??= new Deliveries(this.#rawClient, this.#servers, this.#auth));
  }

  get advances(): Advances {
    return (this.#advances ??= new Advances(this.#rawClient, this.#servers, this.#auth));
  }

  get ops(): Ops {
    return (this.#ops ??= new Ops(this.#rawClient, this.#servers, this.#auth));
  }

  get disputes(): Disputes {
    return (this.#disputes ??= new Disputes(this.#rawClient, this.#servers, this.#auth));
  }

  get agents(): Agents {
    return (this.#agents ??= new Agents(this.#rawClient, this.#servers, this.#auth));
  }

  get vault(): Vault {
    return (this.#vault ??= new Vault(this.#rawClient, this.#servers, this.#auth));
  }

  get demo(): Demo {
    return (this.#demo ??= new Demo(this.#rawClient, this.#servers));
  }

  get dev(): Dev {
    return (this.#dev ??= new Dev(this.#rawClient, this.#servers));
  }
}
