import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

const execFileAsync = promisify(execFile);

// Shared mock CreateOS setup so PLATFORM_URL (read at module import time) binds to our local server.
interface MockSandbox {
  id: string;
  status: "paused" | "running" | "destroyed";
  forked_from: string | null;
  egress: string[];
  rootfs: string;
  created_at: string;
  files: Map<string, Buffer>;
  token?: string;
}

const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const computeBundleDigest = (files: Record<string, Buffer>) => {
  const listing = Object.keys(files)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((p) => `${sha(files[p]!)}  ./${p}\n`)
    .join("");
  return sha(listing);
};

const genuineToolPy = Buffer.from("#!/usr/bin/env python3\nprint('converted')\n");
const tamperedToolPy = Buffer.from("#!/usr/bin/env python3\nprint('converted') ");
const genuineDigest = computeBundleDigest({ "convert.py": genuineToolPy });
const samplePdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >>endobj\n4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n",
  "latin1",
);

const OWNER_KEY = "cos_sb_owner_test_key";
const PARENT_GENUINE = "sb-parent-genuine-01";
const PARENT_LYING = "sb-parent-lying-02";
const PARENT_TAMPERED = "sb-parent-tampered-03";
const sandboxes = new Map<string, MockSandbox>();
let forkCounter = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const createosServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const apiKey = req.headers["x-api-key"];
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/v1/sandboxes") {
    return sendJson(res, 200, { status: "success", data: { items: [...sandboxes.values()] } });
  }

  if (parts[0] === "v1" && parts[1] === "sandboxes" && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    const sb = sandboxes.get(id);
    if (!sb || sb.status === "destroyed") {
      return sendJson(res, 404, { status: "error", data: "sandbox not found" });
    }
    const authorized = apiKey === OWNER_KEY || (sb.token && apiKey === sb.token);
    if (!authorized) {
      return sendJson(res, 403, { status: "error", data: "forbidden" });
    }

    if ((req.method === "GET" || req.method === "PATCH") && parts.length === 3) {
      return sendJson(res, 200, {
        status: "success",
        data: {
          id: sb.id,
          status: sb.status,
          forked_from: sb.forked_from,
          egress: sb.egress,
          rootfs: sb.rootfs,
          created_at: sb.created_at,
        },
      });
    }

    if (req.method === "DELETE" && parts.length === 3) {
      sb.status = "destroyed";
      return sendJson(res, 200, { status: "success", data: { id: sb.id, status: "destroyed" } });
    }

    if (req.method === "POST" && parts[3] === "fork") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const forkId = `sb-worker-${++forkCounter}`;
      const worker: MockSandbox = {
        id: forkId,
        status: body.start_paused ? "paused" : "running",
        forked_from: sb.id,
        egress: [...sb.egress],
        rootfs: sb.rootfs,
        created_at: new Date().toISOString(),
        files: new Map(sb.files),
      };
      sandboxes.set(forkId, worker);
      return sendJson(res, 201, {
        status: "success",
        data: {
          id: worker.id,
          status: worker.status,
          forked_from: worker.forked_from,
          egress: worker.egress,
          rootfs: worker.rootfs,
          created_at: worker.created_at,
        },
      });
    }

    if ((req.method === "PUT" || req.method === "DELETE" || req.method === "PATCH") && parts[3] === "auto-pause") {
      return sendJson(res, 200, { status: "success", data: {} });
    }

    if (req.method === "POST" && parts[3] === "access-token") {
      if (parts[4] === "rotate" || !sb.token) {
        sb.token = `skp_sb_${sb.id}_${Date.now()}`;
        return sendJson(res, 200, { status: "success", data: { token: sb.token } });
      }
      return sendJson(res, 409, { status: "error", data: "token already exists" });
    }

    if (req.method === "DELETE" && parts[3] === "access-token") {
      sb.token = undefined;
      return sendJson(res, 200, { status: "success", data: {} });
    }

    if (req.method === "PUT" && parts[3] === "files") {
      const filePath = url.searchParams.get("path") ?? "";
      const data = await readBody(req);
      sb.files.set(filePath, data);
      return sendJson(res, 200, { status: "success", data: { path: filePath, bytes: data.length } });
    }

    if (req.method === "GET" && parts[3] === "files") {
      const filePath = url.searchParams.get("path") ?? "";
      const data = sb.files.get(filePath);
      if (!data) return sendJson(res, 404, { status: "error", data: "file not found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(data);
    }

    if (req.method === "POST" && parts[3] === "exec") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { cmd?: string; args?: string[] };
      const script = body.args?.join(" ") ?? "";
      let stdout = "";
      let exitCode = 0;

      if (script.includes("/proc/sys/kernel/random/boot_id")) {
        stdout = "boot-uuid-1234\n";
      } else if (script.includes("ls -A /tmp/polygraph-job/in")) {
        const hasInput = [...sb.files.keys()].some((k) => k.startsWith("/tmp/polygraph-job/in/"));
        stdout = hasInput ? "contract.docx\n" : "";
      } else if (script.includes("xargs -0 sha256sum | sha256sum")) {
        const toolFiles: Record<string, Buffer> = {};
        for (const [p, b] of sb.files) {
          if (p.startsWith("/opt/tool/")) toolFiles[p.slice("/opt/tool/".length)] = b;
        }
        stdout = `${computeBundleDigest(toolFiles)}\n`;
      } else if (script.includes("-print0") && script.includes("/opt/tool")) {
        const list = [...sb.files.keys()]
          .filter((p) => p.startsWith("/opt/tool/"))
          .map((p) => `./${p.slice("/opt/tool/".length)}`);
        stdout = `${list.join("\0")}\0`;
      } else if (script.includes("dpkg-query")) {
        stdout = "libreoffice-core\npython3-uno\n";
      } else if (script.includes("dpkg --verify")) {
        stdout = "";
      } else if (script.includes("sitecustomize.py")) {
        stdout = "";
      } else if (script.includes("sha256sum ")) {
        const match = script.match(/sha256sum\s+'([^']+)'/);
        const filePath = match?.[1] ?? "";
        const data = sb.files.get(filePath);
        if (!data) exitCode = 1;
        else stdout = `${sha(data)}  ${filePath}\n`;
      } else if (script.includes("/opt/tool/convert.py")) {
        const outPdf = "/tmp/polygraph-job/out/contract.pdf";
        sb.files.set(outPdf, samplePdf);
        stdout = `${outPdf}\n`;
      } else if (script.includes(".pdf") && script.includes("find ")) {
        const pdfPath = [...sb.files.keys()].find((k) => k.endsWith(".pdf")) ?? "";
        stdout = pdfPath ? `${pdfPath}\n` : "";
      } else if (script.includes("pdfinfo")) {
        stdout = "1\n";
      }

      return sendJson(res, 200, {
        status: "success",
        data: { result: { stdout, stderr: "", exit_code: exitCode }, exec_ms: 5 },
      });
    }
  }

  return sendJson(res, 404, { status: "error", data: "unhandled mock createos route" });
});

// Start mock CreateOS server and configure env before importing workspace modules
await new Promise<void>((resolveListen) => createosServer.listen(0, "127.0.0.1", resolveListen));
const createosPort = (createosServer.address() as { port: number }).port;
const createosUrl = `http://127.0.0.1:${createosPort}`;

process.env.CREATEOS_SANDBOX_API_KEY = OWNER_KEY;
process.env.CREATEOS_SANDBOX_BASE_URL = createosUrl;
process.env.STRIPE_SECRET_KEY = "sk_test_mock_secret_key_0000000000000000000000";
process.env.STRIPE_PROFILE_ID = "sp_test_profile_01";
process.env.MPP_SECRET_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.PUBLISH_TOKEN = "test-publish-token";
process.env.DEMO_FOILS = "1";
process.env.POOL_SIZE = "0";
process.env.ORPHAN_SWEEP = "0";

test.after(() => {
  createosServer.close();
});

// ---------------------------------------------------------------------------
// 1. Unit tests for @polygraph/core signing, canonical JSON & suite digests
// ---------------------------------------------------------------------------
test("core signing, canonicalJson, verifyManifest, and acceptanceSuiteDigest", async () => {
  const core = await import("../packages/core/src/index.js");

  assert.equal(
    core.canonicalJson({ b: 2, a: 1, skip: undefined, nested: { y: true, x: false } }),
    '{"a":1,"b":2,"nested":{"x":false,"y":true}}',
  );

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = {
    offerId: "offer_test01",
    name: "Test Converter",
    description: "Converts documents",
    source: { repo: "https://example.com/repo", license: "MIT" },
    parentSandboxId: "sb-parent-01",
    egress: ["127.0.0.1:9"],
    artifactDigest: "a".repeat(64),
    priceUsd: "0.50",
    checks: [{ id: "unit", label: "Unit test", status: "pass" as const }],
    createdAt: "2026-10-18T00:00:00.000Z",
  };

  const signed = core.signManifest(manifest, privateKey, publicKey);
  assert.deepEqual(core.verifyManifest(signed), { valid: true });

  const tamperedPrice = { ...signed, manifest: { ...signed.manifest, priceUsd: "0.01" } };
  const verdict = core.verifyManifest(tamperedPrice);
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason ?? "", /differs/i);

  const malformed = { ...signed, jws: "only.two" };
  assert.equal(core.verifyManifest(malformed).valid, false);

  const digestA = core.acceptanceSuiteDigest([
    { path: "b.py", content: Buffer.from("print('b')\n") },
    { path: "a.py", content: Buffer.from("print('a')\n") },
  ]);
  const digestB = core.acceptanceSuiteDigest([
    { path: "./a.py", content: Buffer.from("print('a')\n") },
    { path: "b.py", content: Buffer.from("print('b')\n") },
  ]);
  assert.equal(digestA, digestB);
  assert.match(digestA, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 2. Stripe test-mode guard refuses live keys
// ---------------------------------------------------------------------------
test("gateway refuses Stripe live-mode secret keys", async () => {
  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "-e", "import('./apps/gateway/src/payments.ts')"],
        {
          env: {
            ...process.env,
            STRIPE_SECRET_KEY: "sk_live_should_never_be_accepted",
          },
        },
      ),
    /live-mode keys are disabled/i,
  );
});

// ---------------------------------------------------------------------------
// 3. End-to-end Gateway + Buyer + Stripe MPP (test mode) + Tamper Refusal
// ---------------------------------------------------------------------------
test("end-to-end workflow: pre-payment refusal, post-payment refund, and genuine conversion", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "grok-bot-e2e-"));
  const hadDataBuyer = existsSync(resolve("data/buyer"));

  sandboxes.clear();
  sandboxes.set(PARENT_GENUINE, {
    id: PARENT_GENUINE,
    status: "paused",
    forked_from: null,
    egress: ["127.0.0.1:9"],
    rootfs: "devbox:1",
    created_at: new Date().toISOString(),
    files: new Map([["/opt/tool/convert.py", genuineToolPy]]),
  });
  sandboxes.set(PARENT_LYING, {
    id: PARENT_LYING,
    status: "paused",
    forked_from: null,
    egress: [],
    rootfs: "devbox:1",
    created_at: new Date().toISOString(),
    files: new Map([["/opt/tool/convert.py", genuineToolPy]]),
  });
  sandboxes.set(PARENT_TAMPERED, {
    id: PARENT_TAMPERED,
    status: "paused",
    forked_from: null,
    egress: ["127.0.0.1:9"],
    rootfs: "devbox:1",
    created_at: new Date().toISOString(),
    files: new Map([["/opt/tool/convert.py", tamperedToolPy]]),
  });

  const stripeRecords = {
    spts: [] as string[],
    paymentIntents: [] as { id: string; amount: number; metadata: Record<string, string> }[],
    refunds: [] as { id: string; paymentIntent: string; reason: string }[],
  };
  let piSeq = 0;
  let sptSeq = 0;
  let refSeq = 0;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith("https://api.stripe.com/")) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const decodedAuth = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : "";
      assert.ok(decodedAuth.includes("_test_"), "Stripe request must use a test-mode key");

      const u = new URL(urlStr);
      if (u.pathname === "/v1/test_helpers/shared_payment/granted_tokens") {
        const sptId = `spt_test_${++sptSeq}`;
        stripeRecords.spts.push(sptId);
        return new Response(JSON.stringify({ id: sptId, object: "shared_payment.granted_token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const paymentsMod = await import("../apps/gateway/src/payments.js");
  (paymentsMod.stripeClient as unknown as { paymentIntents: unknown }).paymentIntents = {
    create: async (params: { amount: number }) => {
      const piId = `pi_test_${++piSeq}`;
      stripeRecords.paymentIntents.push({ id: piId, amount: params.amount, metadata: {} });
      return { id: piId, status: "succeeded", lastResponse: { headers: {} } };
    },
    update: async (id: string, params: { metadata?: Record<string, string> }) => {
      const pi = stripeRecords.paymentIntents.find((p) => p.id === id);
      if (pi && params.metadata) Object.assign(pi.metadata, params.metadata);
      return { id, status: "succeeded" };
    },
  };
  (paymentsMod.stripeClient as unknown as { refunds: unknown }).refunds = {
    create: async (params: { payment_intent: string; metadata?: Record<string, string> }) => {
      const refundId = `re_test_${++refSeq}`;
      stripeRecords.refunds.push({
        id: refundId,
        paymentIntent: params.payment_intent,
        reason: params.metadata?.polygraph_refund_reason ?? "",
      });
      return { id: refundId, status: "succeeded" };
    },
  };

  const { config } = await import("../apps/gateway/src/config.js");
  const { registerEventRoutes } = await import("../apps/gateway/src/events.js");
  const { registerOfferRoutes } = await import("../apps/gateway/src/offers.js");
  const { registerPublishRoutes } = await import("../apps/gateway/src/publish.js");
  const { registerInspectRoutes } = await import("../apps/gateway/src/inspect.js");
  const { registerPurchaseRoutes } = await import("../apps/gateway/src/purchase.js");
  const { registerDiscoveryRoutes } = await import("../apps/gateway/src/discovery.js");

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, warmWorkers: 0, poolSizePerOffer: 0 }));
  registerEventRoutes(app);
  registerOfferRoutes(app);
  registerPublishRoutes(app);
  registerInspectRoutes(app);
  registerPurchaseRoutes(app);
  registerDiscoveryRoutes(app);
  app.use("/*", serveStatic({ root: config.webRoot }));

  let gatewayPort = 0;
  const gatewayServer = await new Promise<ReturnType<typeof serve>>((resolveServer) => {
    const srv = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      gatewayPort = info.port;
      resolveServer(srv);
    });
  });

  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  process.env.POLYGRAPH_GATEWAY_URL = gatewayUrl;

  const publishedIds: string[] = [];
  try {
    const [healthRes, homeRes, llmsRes, openapiRes] = await Promise.all([
      fetch(`${gatewayUrl}/health`),
      fetch(`${gatewayUrl}/`),
      fetch(`${gatewayUrl}/llms.txt`),
      fetch(`${gatewayUrl}/openapi.json`),
    ]);
    assert.equal(healthRes.status, 200);
    assert.equal(homeRes.status, 200);
    assert.match(await homeRes.text(), /Polygraph/);
    assert.equal(llmsRes.status, 200);
    assert.match(await llmsRes.text(), /Polygraph gateway/);
    assert.equal(openapiRes.status, 200);

    const { signManifest } = await import("../packages/core/src/index.js");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");

    const baseManifest = {
      name: "Document to PDF (LibreOffice)",
      description: "Test converter offer",
      source: { repo: "https://github.com/unoconv/unoserver", license: "MIT" },
      egress: ["127.0.0.1:9"],
      checks: [{ id: "acceptance", label: "Acceptance suite", status: "pass" as const, detail: "17 passed" }],
      createdAt: new Date().toISOString(),
    };

    const publishTestOffer = async (offerId: string, parentSandboxId: string, priceUsd: string, artifactDigest: string, foil?: string) => {
      const signed = signManifest({ ...baseManifest, offerId, parentSandboxId, priceUsd, artifactDigest }, privateKey, publicKey);
      const res = await fetch(`${gatewayUrl}/offers`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-polygraph-publish-token": "test-publish-token" },
        body: JSON.stringify({ offer: signed, ...(foil ? { foil } : {}) }),
      });
      assert.equal(res.status, 201);
      publishedIds.push(offerId);
    };

    await publishTestOffer("offer_e2e_lying", PARENT_LYING, "0.50", genuineDigest, "lying-egress");
    await publishTestOffer("offer_e2e_tampered", PARENT_TAMPERED, "0.51", genuineDigest, "tampered-artifact");
    await publishTestOffer("offer_e2e_genuine", PARENT_GENUINE, "0.52", genuineDigest);

    const { run } = await import("../apps/buyer/src/run.js");
    const outDir = join(workDir, "out");
    const completed = await run({
      gateway: gatewayUrl,
      file: resolve("apps/buyer/fixtures/contract.docx"),
      pay: "test",
      mode: "worker",
      outDir,
      trustSeller: true,
    });

    assert.equal(completed, true, "buyer run should complete using the genuine offer");
    assert.equal(stripeRecords.spts.length, 2, "only tampered + genuine offers should mint test SPTs");
    assert.equal(stripeRecords.paymentIntents.length, 2, "only 2 PaymentIntents should be created");
    assert.equal(stripeRecords.refunds.length, 1, "tampered-artifact purchase must be refunded");
    assert.equal(stripeRecords.refunds[0]!.paymentIntent, stripeRecords.paymentIntents[0]!.id);
    assert.equal(stripeRecords.paymentIntents[1]!.metadata.offerId, "offer_e2e_genuine");
    assert.equal(stripeRecords.paymentIntents[1]!.metadata.parentSandboxId, PARENT_GENUINE);

    const pdfPath = join(outDir, "contract.pdf");
    const receiptPath = join(outDir, "contract.receipt.json");
    assert.equal(existsSync(pdfPath), true);
    assert.equal(existsSync(receiptPath), true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      offerId: string;
      parentSandboxId: string;
      workerSandboxId: string;
      paymentIntentId: string;
      mode: string;
    };
    assert.equal(receipt.offerId, "offer_e2e_genuine");
    assert.equal(receipt.parentSandboxId, PARENT_GENUINE);
    assert.equal(receipt.mode, "seller-worker");
    assert.equal(sandboxes.get(receipt.workerSandboxId)?.status, "destroyed", "worker must be destroyed after done");
  } finally {
    globalThis.fetch = realFetch;
    for (const id of publishedIds) {
      await fetch(`${gatewayUrl}/offers/${id}`, {
        method: "DELETE",
        headers: { "x-polygraph-publish-token": "test-publish-token" },
      }).catch(() => undefined);
    }
    await new Promise<void>((r) => gatewayServer.close(() => r()));
    rmSync(workDir, { recursive: true, force: true });
    rmSync(resolve("apps/gateway/.runtime"), { recursive: true, force: true });
    if (!hadDataBuyer) rmSync(resolve("data/buyer"), { recursive: true, force: true });
  }
});
