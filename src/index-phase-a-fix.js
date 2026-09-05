import baseWorker from "./index.js";
import {
  getPhaseAClosureStatusFixed,
  repairPhaseAResiduals
} from "./phase-a-residuals.js";
import { getPhaseBEventPreview } from "./phase-b-events.js";

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

function bearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function parseLimit(url, fallback = 60, max = 120) {
  const n = Number(url.searchParams.get("limit") || fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

async function repairEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const requested = Number(url.searchParams.get("roles") || 8);
  const maxRoleItems = Number.isFinite(requested)
    ? Math.max(1, Math.min(12, Math.trunc(requested)))
    : 8;

  const result = await repairPhaseAResiduals(env.DB, env, {
    maxRoleItems,
    maxDurationMs: 40000,
    interRequestDelayMs: 4000,
    reviewScanLimit: 100,
    staleLimit: 100
  });

  return json({ ok: true, trigger: "repair_phase_a_residuals", ...result });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/phase-a-closure-status" && request.method === "GET") {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
      const result = await getPhaseAClosureStatusFixed(env.DB);
      return json({ ok: true, ...result });
    }

    if (url.pathname === "/api/repair-phase-a-residuals" && request.method === "POST") {
      return repairEndpoint(request, env, url);
    }

    if (url.pathname === "/api/phase-b-event-preview" && request.method === "GET") {
      if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
      const club = (url.searchParams.get("club") || "ol").trim().toLowerCase();
      if (!["ol", "psg", "om"].includes(club)) {
        return json({ ok: false, error: "Unsupported club", allowed: ["ol", "psg", "om"] }, { status: 400 });
      }
      const limit = parseLimit(url, 60, 120);
      const articleId = (url.searchParams.get("article_id") || "").trim() || null;
      const result = await getPhaseBEventPreview(env.DB, club, limit, articleId);
      return json({ ok: true, ...result });
    }

    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    // Preserve the existing collection + deterministic Phase A + original role
    // classifier schedule. Phase B event extraction stays preview-only and is
    // deliberately NOT connected to scheduled production processing.
    baseWorker.scheduled(event, env, ctx);
    ctx.waitUntil(
      repairPhaseAResiduals(env.DB, env, {
        maxRoleItems: 8,
        maxDurationMs: 40000,
        interRequestDelayMs: 4000,
        reviewScanLimit: 100,
        staleLimit: 100
      })
    );
  }
};
