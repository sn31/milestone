# Generating an SDK with APIMatic

`docs/openapi.yaml` is an OpenAPI 3.1 description of the HTTP routes under `apps/web/src/app/api`. Authentication is the `milestone_actor` cookie (an `apiKey` security scheme in a cookie).

1. In the APIMatic dashboard, create an API Entity and import `docs/openapi.yaml` (upload the file, or point to the raw file URL once the repository is public).
2. Run the validator. Expect warnings, not errors: the contract and approval routes answer with 303 redirects, and two routes (the webhooks) set `security: []` because they use signatures instead of the cookie.
3. Choose a language (TypeScript is the natural fit), generate, and download the package.
4. Configure the base URL to your deployment, and send the cookie on every call (APIMatic exposes cookie auth as a custom header or an API key setting depending on the language).

Notes for what to expect:
- `createContract` takes a form body, not JSON.
- The two webhook operations are for completeness. A client SDK should not call them; PayPal and GitHub do.
- Delivery and advance routes are not in the spec because they are not implemented as HTTP routes.

Regenerate the SDK whenever a route changes; the spec is written by hand from the route handlers and the zod types in `packages/core/src/schemas.ts`, so update both together. Import the Postman collection in `fixtures/postman/` to try the same routes by hand.
