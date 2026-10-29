import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTranscript, validateTranscript } from '../extension/lib/analyzer.mjs';
import { SAMPLE_TRANSCRIPT, SAMPLE_TITLE } from '../extension/lib/sample.mjs';

test('sample separates administrative work from strategic judgment and cites exact source', () => {
  const result = analyzeTranscript(SAMPLE_TRANSCRIPT);
  assert.equal(result.title, SAMPLE_TITLE);
  assert.equal(result.mode, 'demo');
  assert.deepEqual(result.tasks.map((task) => task.type), ['email', 'schedule', 'update', 'document']);
  assert.equal(result.actionItems.length, 1);
  assert.match(result.actionItems[0].title, /evaluate/);
  for (const task of result.tasks) {
    assert.ok(SAMPLE_TRANSCRIPT.includes(task.evidence));
    assert.equal(task.owner, 'Maya');
    assert.equal(task.status, 'suggested');
    assert.ok(task.draft.includes('['), 'Unknown destinations remain placeholders.');
  }
});

test('new input changes results and uncertain ownership remains unassigned', () => {
  const result = analyzeTranscript('Please send a follow-up email to the research team. We agreed to focus on retention.');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].owner, 'Unassigned');
  assert.match(result.tasks[0].evidence, /research team/);
  assert.match(result.decisions[0], /retention/);
});

test('negated, canceled and completed instructions do not become suggestions', () => {
  for (const line of [
    'Maya: Do not send a follow-up email to anyone.',
    "Maya: I won't schedule a meeting this week.",
    'Alex: We should cancel the plan to send an email.',
    'Maya: I already sent the follow-up email yesterday.',
    'Maya: Please skip the progress update and do not share it.',
  ]) assert.deepEqual(analyzeTranscript(line).tasks, [], line);
});

test('ordinary conversation is not an administrative task', () => {
  const result = analyzeTranscript('Alex: Email is a useful communication tool. Maya: The meeting was helpful.');
  assert.equal(result.tasks.length, 0);
});

test('explicit assignment is retained and repeated requests are deduplicated', () => {
  const result = analyzeTranscript('Alex: Maya, please send a follow-up email to the design team.\nAlex: Maya, please send a follow-up email to the design team.');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].owner, 'Maya');
});

test('empty, non-string, and oversized transcripts fail clearly', () => {
  for (const input of ['', 'too short', null, {}, 'x'.repeat(20001)]) assert.throws(() => validateTranscript(input));
});
