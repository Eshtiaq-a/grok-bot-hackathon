# Polygraph

Verifiable pay-per-call AI agent tool marketplace and trust gateway.

Buyer agents check every seller claim against **CreateOS** platform records before **Stripe Machine Payments** clears. A mismatch refuses the purchase with zero PaymentIntents created; post-pay integrity failures refund automatically.

## Architecture

| Package | Role |
|---|---|
| `packages/core` | Shared contracts, Ed25519 JWS attest/verify, CreateOS helpers, event types |
| `apps/seller` | Packages a tool in a sandbox, hardens egress, seals acceptance, signs and publishes offers |
| `apps/gateway` | Hono gateway: offer registry, inspect tokens, MPP 402 payments, warm worker pool, SSE feed, UI |
| `apps/buyer` | Pre/post-payment verifier, Stripe test/Link payer, job runner, receipts |
| `apps/web/public` | Product site and live operations console |
| `tests/` | End-to-end workflow tests with mocked CreateOS and Stripe |

## Protocol

1. **Publish** — Seller builds and hardens a tool, pauses the parent sandbox, signs an `OfferManifest`.
2. **Verify** — Buyer validates the JWS, then inspects CreateOS (status, egress, digests) before paying.
3. **Pay** — `POST /offers/:id/buy` issues an HTTP 402 MPP challenge; successful payment forks a worker.
4. **Execute** — Buyer re-verifies the worker, runs the job, keeps a receipt, or requests a refund.

## Setup

Requires Node.js `>= 20`.

```bash
npm install
npm run typecheck
npm test
npm run preview   # product UI + recorded session at http://localhost:4242/?demo=1
```

Copy `.env.example` to `.env` and fill CreateOS / Stripe test / Anthropic credentials. Live Stripe keys are rejected.

| Variable | Used by | Purpose |
|---|---|---|
| `CREATEOS_SANDBOX_API_KEY` | Gateway, Seller | CreateOS Sandbox API key |
| `STRIPE_SECRET_KEY` | Gateway, Buyer | Stripe **test** secret (`sk_test_...` / `rk_test_...`) |
| `STRIPE_PROFILE_ID` | Gateway | Machine Payments profile ID |
| `MPP_SECRET_KEY` | Gateway | Signs 402 challenges |
| `ANTHROPIC_API_KEY` | Seller | LLM build/fix loop |
| `SELLER_SIGNING_KEY` | Seller, Integrity lab | Base64 PKCS8 Ed25519 private key |
| `POLYGRAPH_GATEWAY_URL` | Buyer, Seller | Gateway base URL (default `http://localhost:4242`) |

Optional: `DEMO_FOILS=1` lists foil offers; `DEMO_TAMPER=1` enables the Integrity lab (`POST /demo/tamper`). Both default off for production-style runs.

Generate keys:

```bash
openssl genpkey -algorithm ed25519 | base64 | tr -d '\n'   # SELLER_SIGNING_KEY
openssl rand -hex 32                                       # MPP_SECRET_KEY
```

## Run

```bash
npm run gateway
npm run seller
npm run buyer -- --file apps/buyer/fixtures/contract.docx --trust-seller
npm run tamper-matrix -- --gateway http://localhost:4242
```

Buyer payment modes: `--pay test` (default, Stripe test SPT) or `--pay link` (Link wallet in test mode). Execution modes: `--mode worker` (default) or `--mode own` (buyer’s CreateOS account).

## API surface

- `GET /offers`, `GET /offers/:id` — signed offers
- `GET /offers/:id/inspect` — short-lived CreateOS parent token
- `POST /offers/:id/buy` — MPP purchase / worker grant
- `POST /purchases/:id/refund`, `POST /purchases/:id/done`
- `GET /events` — SSE operations feed
- `GET /openapi.json`, `GET /llms.txt` — machine-readable agent docs
- `GET /health`

## License lineage

Architecture adapted from [Polygraph](https://github.com/kinnuworks/polygraph). This repository packages it as a production-facing product surface for agent tool payments.
