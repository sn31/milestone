# The TypeScript SDK, generated with APIMatic

`docs/openapi.yaml` is an OpenAPI 3.1 description of the HTTP routes under `apps/web/src/app/api`. APIMatic's validator accepts it with no errors, and `sdks/typescript/` is the TypeScript SDK APIMatic generated from it (`@apimatic/cli` 2.2.0). The SDK is committed as generated, plus one example.

## Using it

```bash
cd sdks/typescript
npm install --ignore-scripts && npm run build   # compiles to dist/ (esm and commonjs)
npx tsx examples/smoke.ts                       # against http://localhost:3000; MILESTONE_URL=... for another host
```

`examples/smoke.ts` is read-only. It asks for the PayPal mode, asks for an advance offer as the freelancer (a typed `AdvanceOfferResponse`), and asks again as the client, which the route refuses with a 403 that the SDK raises as a typed `MilestoneApiError`. A run against the seeded local app:

```
PayPal mode: { mode: 'sandbox' }
Advance offer on mst_3 (100.00 USD in escrow):
  offer: { eligible: false, reason: 'milestone is not eligible for an advance' }
  terms: null
  explanation: No advance is offered: milestone is not eligible for an advance. (rules)
client: refused with 403: { kind: 'error2', body: { error: 'only the freelancer can see advance offers' } }
```

Authentication: the demo has no sign-in. The `milestone_actor` cookie names the role, and the SDK sends it through APIMatic's cookie auth scheme (`new MilestoneApiClient({ roleCookie: "usr_freelancer" })`). Agents use `mandateToken` (`Authorization: Bearer msa_...`) on the routes that accept it.

The SDK's own guides are `sdks/typescript/README.md`, `api-reference.md` and `sdk-map.md`.

## Regenerating

```bash
npx @apimatic/cli auth login
mkdir -p /tmp/apimatic/src/spec && cp docs/openapi.yaml /tmp/apimatic/src/spec/
npx @apimatic/cli api validate --file=docs/openapi.yaml
npx @apimatic/cli sdk generate -l typescript -i /tmp/apimatic -d sdks/typescript -f
```

The spec is written by hand from the route handlers and the zod types in `packages/core/src/schemas.ts`, so update both together and regenerate when a route changes. Constraints the generator imposes:

- Every operation needs a description, and a summary must be plain text (no parentheses or quotes).
- A multipart file array is not supported, so the upload's `files` field is described as one file. The route reads every `files` field, so repeating it still sends up to 10.

Notes:

- `createContract` takes a form body, not JSON.
- The two webhook operations are for completeness. A client should not call them; PayPal and GitHub do.
- The `/api/dev/paypal/*` operations exist only while `PAYPAL_MODE=simulated`.
- Response bodies of the agent, vault, dispute, status, reconcile and demo routes are not fully modelled, so those operations resolve to `undefined`.

To try the same routes by hand, import the Postman collection in `fixtures/postman/`.
