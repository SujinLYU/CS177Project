import test from 'node:test';
import assert from 'node:assert/strict';
import { approveTask, prepareApprovedDraft, dismissTask } from '../extension/lib/workflow.mjs';

const task = { id: 'task-1', status: 'suggested', draft: 'Original draft' };
test('no task can prepare a draft before explicit approval', () => {
  assert.throws(() => prepareApprovedDraft(task), /explicit approval/);
  assert.throws(() => prepareApprovedDraft(dismissTask(task)), /explicit approval/);
});
test('prepares exactly the edited text the user approved, without mutating the suggestion', () => {
  const approved = approveTask(task, ' Edited by the PM ');
  const ready = prepareApprovedDraft(approved);
  assert.equal(ready.result.text, 'Edited by the PM');
  assert.equal(ready.result.kind, 'local-draft');
  assert.equal(task.status, 'suggested');
  assert.equal(task.draft, 'Original draft');
  assert.throws(() => prepareApprovedDraft(ready), /explicit approval/);
});
test('editing a previously approved payload invalidates execution', () => {
  const approved = approveTask(task, 'Reviewed content');
  assert.throws(() => prepareApprovedDraft({ ...approved, draft: 'Changed content' }), /changed/);
});
test('empty drafts and dismissed tasks cannot be approved', () => {
  assert.throws(() => approveTask(task, '  '), /Add a draft/);
  assert.throws(() => approveTask(dismissTask(task), 'Draft'), /suggested/);
});
