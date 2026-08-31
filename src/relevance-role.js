export const ROLE_CLASSIFIER_VERSION = "phase-a-role-classifier-v1";

export const ROLE_LABELS = [
  "subject",
  "transfer_party",
  "financial_stakeholder",
  "opponent",
  "historical_reference",
  "relative_or_personal_link",
  "incidental",
  "unclear"
];

export const AUTO_RELEVANT_ROLES = new Set([
  "subject",
  "transfer_party",
  "financial_stakeholder"
]);

export function buildRoleClassifierPrompt(input) {
  const aliases = Array.isArray(input.aliases) ? input.aliases : [];
  const matchedField = input.matched_field || null;
  const matchedText =
    matchedField === "excerpt"
      ? String(input.excerpt || "").slice(0, 700)
      : matchedField === "lead"
        ? String(input.lead || "").slice(0, 700)
        : String(input.match_context || "").slice(0, 700);

  const payload = {
    club_id: input.club_id,
    club_name: input.club_name || input.club_id,
    aliases,
    title: String(input.title || "").slice(0, 300),
    matched_alias: input.matched_alias || null,
    matched_field: matchedField,
    match_context: String(input.match_context || "").slice(0, 500) || null,
    matched_text: matchedText
  };

  return [
    {
      role: "system",
      content:
        "You classify the role of one football club in the PRIMARY NEWS SUBJECT of an article. " +
        "Return JSON only. Do not judge writing quality. Do not infer facts not present in the supplied text. " +
        "Allowed role values: subject, transfer_party, financial_stakeholder, opponent, historical_reference, " +
        "relative_or_personal_link, incidental, unclear. " +
        "Use subject when the club itself, its current squad, sporting result, decision, management or current situation is a principal subject. " +
        "Use transfer_party when the club is directly involved in a transfer/loan/contract negotiation central to the article. " +
        "Use financial_stakeholder when the club directly gains/loses money or has a contractual financial stake central enough to matter. " +
        "Use opponent when the club is only mentioned as a recent/upcoming match opponent or score context. " +
        "Use historical_reference when it is only a former club, past career stop, old transfer, or biographical reference. " +
        "Use relative_or_personal_link when it is only connected through a relative, teammate, acquaintance or similar personal link. " +
        "Use incidental for other non-central mentions. Use unclear when the supplied text is insufficient. " +
        "Output exactly: {\"role\":\"...\",\"confidence\":0.0,\"rationale\":\"short factual reason\"}."
    },
    {
      role: "user",
      content: JSON.stringify(payload)
    }
  ];
}

export function parseRoleClassifierOutput(raw) {
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\`\`\`(?:json)?/i, "").replace(/\`\`\`$/, "").trim();
    value = JSON.parse(trimmed);
  }

  const role = String(value?.role || "").trim();
  const confidence = Number(value?.confidence);
  const rationale = String(value?.rationale || "").trim();

  if (!ROLE_LABELS.includes(role)) {
    throw new Error("invalid_role");
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("invalid_confidence");
  }
  if (!rationale || rationale.length > 500) {
    throw new Error("invalid_rationale");
  }

  return {
    role,
    confidence: Number(confidence.toFixed(3)),
    rationale
  };
}

export function rolePreviewDecision(classification, threshold = 0.7) {
  if (!classification || classification.confidence < threshold) {
    return { decision: "needs_review", reason_code: "role_classifier_low_confidence" };
  }

  if (AUTO_RELEVANT_ROLES.has(classification.role)) {
    return {
      decision: "relevant",
      reason_code: "role_" + classification.role
    };
  }

  if (classification.role === "unclear") {
    return { decision: "needs_review", reason_code: "role_unclear" };
  }

  return {
    decision: "rejected",
    reason_code: "role_" + classification.role
  };
}

function extractAssistantText(payload) {
  const choice = payload?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;

  const content = choice?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || "").join("").trim();
  }

  return "";
}

export async function classifyRoleWithProvider(env, input) {
  const baseUrl = String(env.ROLE_CLASSIFIER_BASE_URL || "").replace(/\/$/, "");
  const model = String(env.ROLE_CLASSIFIER_MODEL || "").trim();
  const apiKey = String(env.ROLE_CLASSIFIER_API_KEY || "").trim();

  if (!baseUrl || !model || !apiKey) {
    return {
      configured: false,
      classifier_version: ROLE_CLASSIFIER_VERSION,
      error: "role_classifier_not_configured",
      bindings: {
        base_url: Boolean(baseUrl),
        model: Boolean(model),
        api_key: Boolean(apiKey)
      }
    };
  }

  let response = null;
  let text = "";
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts += 1;

    response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 220,
        reasoning_effort: "low",
        reasoning_format: "hidden",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "club_relevance_role",
            strict: true,
            schema: {
              type: "object",
              properties: {
                role: {
                  type: "string",
                  enum: ROLE_LABELS
                },
                confidence: {
                  type: "number",
                  minimum: 0,
                  maximum: 1
                },
                rationale: {
                  type: "string",
                  minLength: 1,
                  maxLength: 240
                }
              },
              required: ["role", "confidence", "rationale"],
              additionalProperties: false
            }
          }
        },
        messages: buildRoleClassifierPrompt(input)
      })
    });

    text = await response.text();
    if (response.ok) break;

    if (response.status !== 429 || attempts >= maxAttempts) {
      return {
        configured: true,
        classifier_version: ROLE_CLASSIFIER_VERSION,
        error: "provider_http_error",
        status: response.status,
        attempts,
        detail: text.slice(0, 500)
      };
    }

    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const retryFromBody = Number(
      text.match(/try again in\s+([0-9.]+)s/i)?.[1] || 0
    );
    const retrySeconds = Math.min(
      15,
      Math.max(
        1,
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 0,
        Number.isFinite(retryFromBody) && retryFromBody > 0 ? retryFromBody : 0,
        attempts * 1.5
      )
    );

    await new Promise((resolve) => setTimeout(resolve, Math.ceil(retrySeconds * 1000)));
  }

  if (!response?.ok) {
    return {
      configured: true,
      classifier_version: ROLE_CLASSIFIER_VERSION,
      error: "provider_http_error",
      status: response?.status || 0,
      attempts,
      detail: text.slice(0, 500)
    };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return {
      configured: true,
      classifier_version: ROLE_CLASSIFIER_VERSION,
      error: "provider_invalid_json"
    };
  }

  try {
    const parsed = parseRoleClassifierOutput(extractAssistantText(payload));
    return {
      configured: true,
      classifier_version: ROLE_CLASSIFIER_VERSION,
      model,
      attempts,
      ...parsed
    };
  } catch (error) {
    return {
      configured: true,
      classifier_version: ROLE_CLASSIFIER_VERSION,
      model,
      error: String(error?.message || error)
    };
  }
}
