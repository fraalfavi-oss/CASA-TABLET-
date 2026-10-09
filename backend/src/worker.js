const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function cleanItems(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [id, raw] of Object.entries(input)) {
    if (!raw || typeof raw !== "object") continue;
    if (!["note", "task", "event"].includes(raw.kind)) continue;
    const text = String(raw.text || "").trim().slice(0, 500);
    if (!text) continue;
    const itemId = String(raw.id || id).slice(0, 100);
    out[itemId] = {
      ...raw,
      id: itemId,
      author: raw.author === "Andrea" ? "Andrea" : "Franklin",
      kind: raw.kind,
      text,
      done: raw.kind === "task" ? !!raw.done : false,
      eventDate: raw.kind === "event" ? String(raw.eventDate || "").slice(0, 10) : "",
      eventTime: raw.kind === "event" ? String(raw.eventTime || "").slice(0, 5) : "",
      noteDate: raw.kind === "note" ? String(raw.noteDate || "").slice(0, 10) : "",
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }
  return out;
}

export class HomeState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async load() {
    return (await this.ctx.storage.get("state")) || {
      version: 10,
      rev: 0,
      updatedAt: Date.now(),
      items: {}
    };
  }

  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.endsWith("/health")) {
      return json({ ok: true, storage: "durable-object", version: 10 });
    }

    if (path.endsWith("/state") && request.method === "GET") {
      return json(await this.load());
    }

    if (path.endsWith("/replace") && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const current = await this.load();
      const expectedRev = Number(body.expectedRev);
      if (!Number.isFinite(expectedRev) || expectedRev !== current.rev) {
        return json({ error: "conflict", state: current }, 409);
      }
      const next = {
        version: 10,
        rev: current.rev + 1,
        updatedAt: Date.now(),
        items: cleanItems(body.items)
      };
      await this.ctx.storage.put("state", next);
      return json(next);
    }

    return json({ error: "not_found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/([a-zA-Z0-9_-]+)\/(state|replace|health)$/);
    if (!match) return json({ error: "not_found" }, 404);
    const room = match[1];
    const id = env.HOME.idFromName(room);
    const stub = env.HOME.get(id);
    return stub.fetch(request);
  }
};