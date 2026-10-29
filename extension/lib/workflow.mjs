// Local draft preparation is the only executor in this starter.
// Real providers must re-check approval on the server and use idempotency keys.
export function approveTask(task, draft) {
  if (!task || task.status !== 'suggested') throw new Error('Only a suggested task can be approved.');
  if (typeof draft !== 'string' || !draft.trim()) throw new Error('Add a draft before approving.');
  if (draft.length > 20000) throw new Error('Please keep the draft under 20,000 characters.');
  return { ...task, draft: draft.trim(), approvedDraft: draft.trim(), status: 'approved', approvedAt: new Date().toISOString() };
}

export function prepareApprovedDraft(task) {
  if (!task || task.status !== 'approved' || !task.approvedAt || !task.approvedDraft) {
    throw new Error('Draft preparation requires explicit approval.');
  }
  if (task.draft !== task.approvedDraft) throw new Error('The draft changed. Review and approve it again.');
  return { ...task, status: 'completed', completedAt: new Date().toISOString(), result: { kind: 'local-draft', text: task.approvedDraft } };
}

export function dismissTask(task) {
  if (!task || task.status !== 'suggested') throw new Error('Only a suggested task can be dismissed.');
  return { ...task, status: 'dismissed' };
}
