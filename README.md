# grok-bot-hackathon

Verifiable pay-per-call AI agent tool marketplace and trust-checking gateway, built on CreateOS Sandboxes and Stripe Machine Payments (MPP) in test mode.

> Adapted from the open-source [Polygraph](https://github.com/kinnuworks/polygraph) architecture and replicated for `grok-bot-hackathon`.

## Overview

AI agents that pay per HTTP call for external tools need cryptographic and platform-level proof that the service they are paying for matches what the seller claims. This project sits between the **seller agent**, the **gateway**, and the **buyer agent**:

1. **Create (`apps/seller`)**: A seller agent packages an open-source document converter (LibreOffice / `unoserver`), tests and hardens it inside a CreateOS sandbox, locks outbound egress (`127.0.0.1:9` deny-by-default allowlist), seals an independent Python acceptance suite (`apps/seller/acceptance`), pauses the parent sandbox, and signs an `OfferManifest` with an Ed25519 JWS.
2. **Distrust (`apps/buyer`)**: Before any payment is created, the buyer agent verifies the JWS signature and asks CreateOS directly (using a short-lived parent inspection token from `GET /offers/:id/inspect`) whether the parent sandbox is paused and whether its real egress matches the signed claim. Any mismatch causes immediate refusal with **zero Stripe PaymentIntents created**.
3. **Pay (`apps/gateway` + Stripe MPP)**: `POST /offers/:id/buy` issues an HTTP `402` Machine Payments challenge via `mppx`. The buyer pays **$0.50** in **Stripe test mode** using a single-use Shared Payment Token (`spt_...` via `pm_card_visa` or Link agent wallet), and the gateway forks a fresh worker sandbox from the verified parent, reseeds `/dev/urandom`, records proof IDs onto the PaymentIntent metadata, and returns a scoped `workerToken`.
4. **Verify, Run & Refund**: Before uploading the user's document, the buyer checks the worker directly on CreateOS (`forked_from`, egress, running status), downloads and hashes every tool file locally, verifies the in-worker digest, checks `dpkg --verify` and Python startup hooks, and runs the conversion. If any post-payment check fails, the buyer withholds the document and calls `POST /purchases/:id/refund`; the gateway independently re-audits the worker and issues a full Stripe test-mode refund.

## Repository Layout

```text
packages/core     Shared TypeScript contracts, Ed25519 JWS signing/verification, CreateOS client, event feed
apps/seller       Seller agent CLI, LLM build/fix loop, hardening, hidden acceptance suite, demo foils
apps/gateway      Hono HTTP gateway, offer registry, MPP 402 Stripe payments, warm worker pool, SSE feed
apps/buyer        Buyer agent CLI, pre/post-payment verifier, tamper matrix, Stripe test/Link payer, receipts
apps/web/public   Live console dashboard and recorded-run replay UI
data/events       Recorded event feed replayed on gateway startup
scripts/          Deployment helper (deploy.sh) and offline UI preview server (preview.ts)
tests/            Local end-to-end verification tests (mocking external CreateOS & Stripe endpoints)
```

## Setup & Local Installation

**Prerequisites:** Node.js `>= 20` (tested on Node 24), npm, and (for live sandbox + payment runs) a CreateOS Sandbox API key, a Stripe test-mode sandbox + MPP profile, and an Anthropic API key.

```bash
# 1. Install workspace dependencies
npm install

# 2. Typecheck and run the local end-to-end verification suite
npm run typecheck
npm test

# 3. Preview the dashboard UI offline with the recorded run (no API keys required)
npm run preview
# Open http://localhost:4242/?demo=1
```

## Environment Variables

Copy `.env.example` to `.env` and populate your own sandbox/test credentials (never commit `.env`):

```bash
cp .env.example .env
```

Key required variables for running the live gateway, seller, and buyer:

| Variable | Required by | Description |
|---|---|---|
| `CREATEOS_SANDBOX_API_KEY` | Gateway, Seller | CreateOS Sandbox API key |
| `CREATEOS_SANDBOX_BASE_URL` | All (optional) | CreateOS API URL (default: `https://api-eu.sb.createos.sh`) |
| `STRIPE_SECRET_KEY` | Gateway, Buyer (`--pay test`) | **Must be a Stripe test key (`sk_test_...` or `rk_test_...`)** — live keys are rejected |
| `STRIPE_PROFILE_ID` | Gateway | Stripe Machine Payments (MPP) network/profile ID |
| `MPP_SECRET_KEY` | Gateway | Secret used by `mppx` to sign 402 payment challenges |
| `ANTHROPIC_API_KEY` | Seller | Anthropic API key for drafting/fixing the converter tool |
| `SELLER_SIGNING_KEY` | Seller, Gateway (`/demo/tamper`) | Base64-encoded PKCS8 Ed25519 private key PEM |
| `POLYGRAPH_GATEWAY_URL` | Buyer, Seller, Gateway | Gateway base URL (default: `http://localhost:4242`) |

See [.env.example](file:///Users/eshtiaqahmad/grok%20bot%20hackathon/.env.example) for all optional tuning flags (`DEMO_FOILS`, `DEMO_TAMPER`, `POOL_SIZE`, `ORPHAN_SWEEP`, `BUYER_CREATEOS_SANDBOX_API_KEY`, etc.).

To generate a fresh `SELLER_SIGNING_KEY` and `MPP_SECRET_KEY`:

```bash
openssl genpkey -algorithm ed25519 | base64 | tr -d '\n'   # -> SELLER_SIGNING_KEY
openssl rand -hex 32                                       # -> MPP_SECRET_KEY
```

## Running the Live Sandbox & Stripe Test-Mode Workflow

Once `.env` is configured with your CreateOS and Stripe test-mode credentials:

```bash
# Terminal 1: Start the gateway and live console at http://localhost:4242
npm run gateway

# Terminal 2: Run the seller agent (creates sandbox, builds/tests tool, hardens egress, publishes offer + foils)
npm run seller

# Terminal 3: Run the buyer agent against the local gateway in Stripe test mode
npm run buyer -- --file apps/buyer/fixtures/contract.docx --trust-seller

# Optional: Run the 6-case tamper matrix (5 refused pre-payment, 1 caught & refunded post-payment)
npm run tamper-matrix -- --gateway http://localhost:4242
```

### Stripe Sandbox Testing Notes

- **Test-mode enforcement:** Both `apps/gateway/src/payments.ts` and `apps/buyer/src/pay.ts` enforce that `STRIPE_SECRET_KEY` contains `_test_` and run `mppx` with `livemode: false`. Live-mode keys are refused.
- **Test card payments (`--pay test`, default):** The buyer mints a single-use test Shared Payment Token via `POST https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens` using `pm_card_visa`, verifies the `402` challenge matches the signed `priceUsd` (`$0.50`), and retries `POST /offers/:id/buy`.
- **Link wallet payments (`--pay link`):** Uses `npx @stripe/link-cli mpp pay ... --test` for human-in-the-loop Link app approval without charging a real card.
- **Automatic refunds:** If a worker fails to boot within `BUY_FORK_DEADLINE_SECONDS` (default 45s), receives no job input within `UNUSED_REFUND_SECONDS` (default 300s), or fails post-payment verification at `POST /purchases/:id/refund`, the gateway calls `stripeClient.refunds.create(...)` in test mode and destroys the worker.
