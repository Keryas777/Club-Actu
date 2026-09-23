import baseWorker from "./index.js";
import {
  getPhaseAClosureStatusFixed,
  repairPhaseAResiduals
} from "./phase-a-residuals.js";

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

function parseOffset(url, fallback = 0, max = 5000) {
  const raw = url.searchParams.get("offset");
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
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

async function phaseBEventPreviewEndpoint(env, club, limit, offset, articleId) {
  try {
    // Keep Phase B preview code out of Worker startup. If the preview module or
    // its full-content read path fails, Phase A and all other routes must stay healthy.
    const { getPhaseBEventPreview } = await import("./phase-b-events-full-content.js");
    const result = await getPhaseBEventPreview(env.DB, club, limit, articleId, offset);
    return json({ ok: true, ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("phase-b-event-preview failed", { name, message, club, limit, offset, articleId });
    return json({
      ok: false,
      error: "phase_b_event_preview_failed",
      diagnostic: {
        name,
        message,
        club,
        limit,
        offset,
        article_id: articleId
      }
    }, { status: 500 });
  }
}

async function phaseBEventBatchEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limit = parseLimit(url, 4, 12);
  const rawLookback = Number(url.searchParams.get("lookback_hours") || 72);
  const lookbackHours = Number.isFinite(rawLookback)
    ? Math.max(1, Math.min(24 * 14, Math.trunc(rawLookback)))
    : 72;

  try {
    const { processPhaseBEventPersistenceBatch } = await import("./phase-b-event-queue.js");
    const result = await processPhaseBEventPersistenceBatch(env.DB, {
      limit,
      lookbackHours,
      maxDurationMs: 12000
    });
    return json({ ok: true, trigger: "process_phase_b_event_batch", ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("phase-b-event-batch failed", { name, message, limit, lookbackHours });
    return json({
      ok: false,
      error: "phase_b_event_batch_failed",
      diagnostic: { name, message, limit, lookback_hours: lookbackHours }
    }, { status: 500 });
  }
}

async function scheduledPhaseBEventPersistence(env) {
  if (!env.DB) return null;
  try {
    const { processPhaseBEventPersistenceBatch } = await import("./phase-b-event-queue.js");
    const result = await processPhaseBEventPersistenceBatch(env.DB, {
      limit: Number(env.PHASE_B_EVENT_BATCH_LIMIT || 4),
      lookbackHours: Number(env.PHASE_B_EVENT_LOOKBACK_HOURS || 72),
      maxDurationMs: Number(env.PHASE_B_EVENT_MAX_DURATION_MS || 12000)
    });
    console.log("phase-b-event-persistence-batch", result);
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    // Phase B must never break collection / Phase A scheduled processing.
    console.error("phase-b-event-persistence-batch failed", { name, message });
    return { ok: false, name, message };
  }
}

async function eventEmbeddingBatchEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.AI) return json({ ok: false, error: "Workers AI binding missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limit = parseLimit(url, 4, 12);

  try {
    const { processEventEmbeddingBatch } = await import("./event-embedding-queue.js");
    const result = await processEventEmbeddingBatch(env.DB, env.AI, {
      limit,
      maxDurationMs: 12000
    });
    return json({ ok: true, trigger: "process_event_embedding_batch", ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("event-embedding-batch failed", { name, message, limit });
    return json({
      ok: false,
      error: "event_embedding_batch_failed",
      diagnostic: { name, message, limit }
    }, { status: 500 });
  }
}

async function scheduledEventEmbeddings(env) {
  if (!env.DB || !env.AI) return null;
  try {
    const { processEventEmbeddingBatch } = await import("./event-embedding-queue.js");
    const result = await processEventEmbeddingBatch(env.DB, env.AI, {
      limit: Number(env.EVENT_EMBEDDING_BATCH_LIMIT || 4),
      maxDurationMs: Number(env.EVENT_EMBEDDING_MAX_DURATION_MS || 12000)
    });
    console.log("event-embedding-batch", result);
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    // Embedding production must never break collection / Phase A / EVENT persistence.
    console.error("event-embedding-batch failed", { name, message });
    return { ok: false, name, message };
  }
}


async function scheduledStoryMatching(env) {
  if (!env.DB) return null;
  try {
    const { processStoryMatchBatch } = await import("./story-matcher.js");
    const rawLimit = Number(env.STORY_MATCH_BATCH_LIMIT || 4);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(8, Math.trunc(rawLimit)))
      : 4;
    const result = await processStoryMatchBatch(env.DB, {
      limit,
      maxDurationMs: Number(env.STORY_MATCH_MAX_DURATION_MS || 12000)
    });
    console.log("story-match-batch", result);
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    // STORY matching must never break collection / Phase A / EVENT / embeddings.
    console.error("story-match-batch failed", { name, message });
    return { ok: false, name, message };
  }
}

async function eventEmbeddingStorageRepairEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limit = parseLimit(url, 20, 50);

  try {
    const { repairLegacyTextEmbeddingStorage } = await import("./event-embedding-queue.js");
    const result = await repairLegacyTextEmbeddingStorage(env.DB, { limit });
    return json({ ok: true, trigger: "repair_event_embedding_storage", ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("event-embedding-storage-repair failed", { name, message, limit });
    return json({
      ok: false,
      error: "event_embedding_storage_repair_failed",
      diagnostic: { name, message, limit }
    }, { status: 500 });
  }
}

async function storyMatchBatchEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limit = parseLimit(url, 2, 8);
  const eventId = (url.searchParams.get("event_id") || "").trim() || null;

  try {
    const { processStoryMatchBatch } = await import("./story-matcher.js");
    const result = await processStoryMatchBatch(env.DB, {
      limit,
      eventId,
      maxDurationMs: 12000
    });
    return json({ ok: true, trigger: "process_story_match_batch", ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("story-match-batch failed", { name, message, limit, eventId });
    return json({
      ok: false,
      error: "story_match_batch_failed",
      diagnostic: { name, message, limit, event_id: eventId }
    }, { status: 500 });
  }
}

async function storyAiBatchEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limit = parseLimit(url, 1, 4);
  const rawAttemptId = Number(url.searchParams.get("attempt_id") || 0);
  const attemptId = Number.isInteger(rawAttemptId) && rawAttemptId > 0 ? rawAttemptId : null;

  try {
    const { processStoryAiBatch } = await import("./story-ai-resolver.js");
    const result = await processStoryAiBatch(env.DB, env, {
      limit,
      attemptId,
      maxDurationMs: Number(env.STORY_AI_MAX_DURATION_MS || 30000)
    });
    return json({ ok: true, trigger: "process_story_ai_batch", mode: "shadow_review", ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("story-ai-batch failed", { name, message, limit, attemptId });
    return json({
      ok: false,
      error: "story_ai_batch_failed",
      diagnostic: { name, message, limit, attempt_id: attemptId }
    }, { status: 500 });
  }
}

async function phaseBEventPersistenceEndpoint(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding DB missing" }, { status: 503 });
  if (!env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Manual trigger not configured" }, { status: 503 });
  }

  const token = bearerToken(request);
  if (!token || token !== env.MANUAL_TRIGGER_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const articleId = (url.searchParams.get("article_id") || "").trim();
  if (!articleId) {
    return json({ ok: false, error: "article_id is required" }, { status: 400 });
  }

  try {
    // D1 persistence remains manual at this stage. Nothing here is connected to
    // the scheduled pipeline or to STORY matching.
    const { persistPhaseBEventCandidatesForArticle } = await import("./phase-b-event-persistence.js");
    const result = await persistPhaseBEventCandidatesForArticle(env.DB, articleId);
    return json({ ok: true, trigger: "persist_phase_b_event_candidates", ...result });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.error("phase-b-event-persistence failed", { name, message, articleId });
    return json({
      ok: false,
      error: "phase_b_event_persistence_failed",
      diagnostic: { name, message, article_id: articleId }
    }, { status: 500 });
  }
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
      const offset = parseOffset(url, 0, 5000);
      const articleId = (url.searchParams.get("article_id") || "").trim() || null;
      return phaseBEventPreviewEndpoint(env, club, limit, offset, articleId);
    }

    if (url.pathname === "/api/persist-phase-b-events" && request.method === "POST") {
      return phaseBEventPersistenceEndpoint(request, env, url);
    }

    if (url.pathname === "/api/process-phase-b-event-batch" && request.method === "POST") {
      return phaseBEventBatchEndpoint(request, env, url);
    }

    if (url.pathname === "/api/process-event-embedding-batch" && request.method === "POST") {
      return eventEmbeddingBatchEndpoint(request, env, url);
    }

    if (url.pathname === "/api/repair-event-embedding-storage" && request.method === "POST") {
      return eventEmbeddingStorageRepairEndpoint(request, env, url);
    }

    if (url.pathname === "/api/process-story-match-batch" && request.method === "POST") {
      return storyMatchBatchEndpoint(request, env, url);
    }

    if (url.pathname === "/api/process-story-ai-batch" && request.method === "POST") {
      return storyAiBatchEndpoint(request, env, url);
    }

    return baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    // Preserve collection + Phase A, then run the validated bounded EVENT persistence,
    // embedding and STORY queues independently. Each queue owns its own failure boundary.
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
    ctx.waitUntil(scheduledPhaseBEventPersistence(env));
    // Downstream queues run independently. EVENTs created or embedded in this same cron
    // may wait until the next cycle, which keeps the pipeline bounded and loosely coupled.
    ctx.waitUntil(scheduledEventEmbeddings(env));
    ctx.waitUntil(scheduledStoryMatching(env));
  }
};
