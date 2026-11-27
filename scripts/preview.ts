import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const webRoot = resolve("apps/web/public");
const recordedPath = resolve("data/events/recorded.jsonl");
const port = Number(process.env.PORT ?? 4242);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, mode: "preview", warmWorkers: 0, poolSizePerOffer: 0 }));
app.get("/offers", (c) => c.json([]));
app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    if (existsSync(recordedPath)) {
      const lines = readFileSync(recordedPath, "utf8").split("\n").filter((l) => l.trim());
      let id = 1;
      for (const line of lines.slice(-200)) {
        try {
          const ev = JSON.parse(line) as { type?: string };
          if (ev.type) {
            await stream.writeSSE({ id: String(id++), event: ev.type, data: line });
          }
        } catch {
          /* skip unreadable lines */
        }
      }
    }
    const timer = setInterval(() => void stream.write(": keep-alive\n\n"), 15_000);
    await new Promise<void>((resolveStop) => stream.onAbort(resolveStop));
    clearInterval(timer);
  }),
);

app.get("/*", (c) => {
  const reqPath = c.req.path === "/" ? "index.html" : c.req.path.replace(/^\/+/, "");
  const filePath = resolve(webRoot, reqPath);
  if (!filePath.startsWith(webRoot) || !existsSync(filePath)) {
    return c.json({ error: "not found" }, 404);
  }
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  return new Response(createReadStream(filePath) as unknown as ReadableStream, {
    headers: { "content-type": type },
  });
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`grok-bot-hackathon UI preview listening on http://localhost:${info.port}`);
  console.log(`Recorded replay available directly at http://localhost:${info.port}/?demo=1`);
});
