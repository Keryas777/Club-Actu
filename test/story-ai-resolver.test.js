import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORY_AI_PROMPT_VERSION,
  STORY_AI_RESPONSE_SCHEMA,
  buildStoryAiPrompt,
  parseStoryAiResponse,
  resolveStoryAmbiguityWithProvider,
  storyAiProviderConfig
} from '../src/story-ai-resolver.js';

const input = {
  task: 'story_ambiguity_resolution',
  prompt_version: STORY_AI_PROMPT_VERSION,
  deterministic_match: { best_hybrid_score: 0.61 },
  event: {
    event_id: 'new-event',
    family: 'match',
    evidence: { text: 'OL bat Rennes 4-0.' }
  },
  candidates: [
    {
      story_id: 'story-a',
      story_family: 'match',
      scores: { hybrid: 0.61 },
      representative_members: [
        { event_id: 'member-a', family: 'match', evidence: { text: 'OL-Rennes 4-0.' } }
      ]
    }
  ]
};

test('story AI provider defaults to Workers AI and a JSON-mode model', () => {
  const config = storyAiProviderConfig({});
  assert.equal(config.provider, 'workers_ai');
  assert.match(config.model, /^@cf\//);
  assert.deepEqual(STORY_AI_RESPONSE_SCHEMA.properties.decision.enum, ['attach', 'new_story', 'unsure']);
});

test('prompt treats supplied text as evidence and keeps the task bounded', () => {
  const messages = buildStoryAiPrompt(input);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /evidence only/i);
  assert.match(messages[0].content, /Never choose a story_id that is not supplied/i);
  assert.match(messages[0].content, /SAME CENTRAL DOSSIER/);
  assert.match(messages[0].content, /Zidane may call Tolisso.*Zidane plans a role for Cherki/);
  assert.match(messages[0].content, /supporter-banner.*NOT automatically the match STORY/);
  assert.match(messages[0].content, /line-ups, the result, match analysis and direct post-match reactions/);
  const payload = JSON.parse(messages[1].content);
  assert.deepEqual(payload.candidates.map((row) => row.story_id), ['story-a']);
});

test('parser accepts an attach only to an allowed candidate and cited evidence', () => {
  const result = parseStoryAiResponse({
    decision: 'attach',
    story_id: 'story-a',
    confidence: 0.86,
    rationale: 'Même match et même résultat.',
    evidence_event_ids: ['new-event', 'member-a']
  }, {
    allowedStoryIds: ['story-a'],
    allowedEvidenceIds: ['new-event', 'member-a'],
    newEventId: 'new-event',
    memberEvidenceByStory: { 'story-a': ['member-a'] }
  });
  assert.equal(result.decision, 'attach');
  assert.equal(result.story_id, 'story-a');
  assert.equal(result.confidence, 0.86);
});

test('parser rejects an attach outside the exact candidate set', () => {
  assert.throws(() => parseStoryAiResponse({
    decision: 'attach',
    story_id: 'story-b',
    confidence: 0.9,
    rationale: 'Même sujet.',
    evidence_event_ids: ['new-event']
  }, {
    allowedStoryIds: ['story-a'],
    allowedEvidenceIds: ['new-event', 'member-a'],
    newEventId: 'new-event',
    memberEvidenceByStory: { 'story-a': ['member-a'] }
  }), /ai_story_not_in_candidate_set/);
});

test('parser requires null story_id for new_story and unsure', () => {
  assert.throws(() => parseStoryAiResponse({
    decision: 'new_story',
    story_id: 'story-a',
    confidence: 0.8,
    rationale: 'Sujet distinct.',
    evidence_event_ids: ['new-event']
  }, {
    allowedStoryIds: ['story-a'],
    allowedEvidenceIds: ['new-event', 'member-a'],
    newEventId: 'new-event',
    memberEvidenceByStory: { 'story-a': ['member-a'] }
  }), /ai_non_attach_has_story_id/);
});

test('parser rejects evidence ids that were not supplied to the model', () => {
  assert.throws(() => parseStoryAiResponse({
    decision: 'attach',
    story_id: 'story-a',
    confidence: 0.8,
    rationale: 'Même sujet.',
    evidence_event_ids: ['new-event', 'member-a', 'invented-event']
  }, {
    allowedStoryIds: ['story-a'],
    allowedEvidenceIds: ['new-event', 'member-a'],
    newEventId: 'new-event',
    memberEvidenceByStory: { 'story-a': ['member-a'] }
  }), /ai_unknown_evidence_event/);
});

test('attach requires evidence from the new EVENT and the selected STORY', () => {
  assert.throws(() => parseStoryAiResponse({
    decision: 'attach',
    story_id: 'story-a',
    confidence: 0.7,
    rationale: 'Même sujet.',
    evidence_event_ids: ['new-event']
  }, {
    allowedStoryIds: ['story-a'],
    allowedEvidenceIds: ['new-event', 'member-a'],
    newEventId: 'new-event',
    memberEvidenceByStory: { 'story-a': ['member-a'] }
  }), /ai_attach_missing_story_evidence/);

  assert.throws(() => parseStoryAiResponse({
    decision: 'attach',
    story_id: 'story-a',
    confidence: 0.7,
    rationale: 'Même sujet.',
    evidence_event_ids: ['member-a']
  }, {
    allowedStoryIds: ['story-a'],
    allowedEvidenceIds: ['new-event', 'member-a'],
    newEventId: 'new-event',
    memberEvidenceByStory: { 'story-a': ['member-a'] }
  }), /ai_attach_missing_new_event_evidence/);
});

test('Workers AI adapter requests JSON schema and validates the response', async () => {
  let capturedModel = null;
  let capturedRequest = null;
  const env = {
    AI: {
      async run(model, request) {
        capturedModel = model;
        capturedRequest = request;
        return {
          response: {
            decision: 'attach',
            story_id: 'story-a',
            confidence: 0.77,
            rationale: 'Le nouvel EVENT décrit le même OL-Rennes.',
            evidence_event_ids: ['new-event', 'member-a']
          }
        };
      }
    }
  };
  const result = await resolveStoryAmbiguityWithProvider(env, input);
  assert.equal(result.error, undefined);
  assert.equal(result.decision, 'attach');
  assert.equal(result.story_id, 'story-a');
  assert.match(capturedModel, /^@cf\//);
  assert.equal(capturedRequest.response_format.type, 'json_schema');
  assert.equal(capturedRequest.temperature, 0);
});

test('missing AI binding fails explicitly without inventing a decision', async () => {
  const result = await resolveStoryAmbiguityWithProvider({}, input);
  assert.equal(result.configured, false);
  assert.equal(result.error, 'story_ai_not_configured');
  assert.equal(result.decision, undefined);
});
