/** Offline, deliberately conservative rules for a classroom demo; this is not an LLM. */
export const MAX_TRANSCRIPT_LENGTH = 20000;

export function validateTranscript(transcript) {
  if (typeof transcript !== 'string' || transcript.trim().length < 20) {
    throw new Error('Paste at least 20 characters of meeting notes.');
  }
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    throw new Error('Please keep meeting notes under 20,000 characters.');
  }
  return transcript.trim();
}

const negated = /\b(?:not|never|no longer|do not|don't|don’t|won't|won’t|shouldn't|shouldn’t|already|cancel|cancelled|canceled|avoid|stop|skip|unnecessary)\b|不用|不要|无需|已经/iu;
const strategic = /(?:^|\b(?:will|should|must|to)\s+)(?:evaluate|prioritize|decide|research|investigate|analyze|validate|design|build|implement)\b/iu;
const commitment = /\b(?:will|shall|should|must|need to|please|can you|could you|let's|let’s|remember to|action item)\b|(?:^|:\s*)(?:send|email|schedule|book|share|post|add|update|document|evaluate|prioritize|decide|research|investigate|analyze|validate|build|implement)\b|需要|请|记得|我会/iu;
const patterns = [
  { type: 'email', title: 'Draft the follow-up email', minutes: 5, test: /\b(?:send|draft|write)\b.*\b(?:email|e-mail)\b|\bemail\s+(?!(?:is|was|has|can|will|should)\b)(?:the|our|a|an|[A-Z])|发.*邮件|写.*邮件/iu },
  { type: 'schedule', title: 'Prepare the meeting invite', minutes: 4, test: /\b(?:schedule|book|arrange|set up)\b.*\b(?:meeting|call|sync|check-in|session|review)\b|安排.*(?:会议|沟通)/iu },
  { type: 'update', title: 'Draft the team update', minutes: 3, test: /\b(?:share|post|send)\b.*\b(?:update|recap|summary|channel|slack)\b|分享.*(?:进展|更新)|发.*群/iu },
  { type: 'document', title: 'Prepare the notes update', minutes: 4, test: /\b(?:add|update|document|record|copy)\b.*\b(?:notes|document|doc|decisions|minutes|link)\b|更新.*文档|记录.*决策/iu },
];

function segments(text) {
  return text.split(/\r?\n/).flatMap((line) => line.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/gu) || [])
    .map((line) => line.trim()).filter(Boolean);
}

function withoutSpeaker(line) {
  return line.replace(/^(?:\[?\d{1,2}:\d{2}\]?\s*)?[\p{L}][\p{L}\s.'-]{0,35}:\s*/u, '').trim();
}

function ownerOf(line) {
  const speaker = line.match(/^(?:\[?\d{1,2}:\d{2}\]?\s*)?([\p{L}][\p{L}\s.'-]{0,35}):\s*(?:I will|I'll|I’ll|I can|我会)/iu);
  if (speaker) return speaker[1].trim();
  const assignee = withoutSpeaker(line).match(/^([A-Z][a-z]+),?\s+(?:please|can you|could you|will)\b/u);
  return assignee?.[1] || 'Unassigned';
}

function draftFor(type, evidence) {
  const request = withoutSpeaker(evidence);
  const templates = {
    email: `To: [confirm recipient]\nSubject: Meeting follow-up\n\nHi team,\n\nFollowing up on our meeting:\n[Add the decisions and any links you want to share.]\n\nSource request: ${request}\n\nThanks,\n[Your name]`,
    schedule: `Title: Design / team check-in [confirm]\nAttendees: [confirm names and email addresses]\nWhen: [confirm date, time, and timezone]\n\nAgenda\n${request}\n\n[Confirm duration and video-call link before creating an invite.]`,
    update: `Channel: [confirm destination]\n\nQuick meeting update\n[Add the key decision and current progress.]\n\nSource request: ${request}\n\nNext step: [confirm owner and timing]`,
    document: `Document: [confirm destination]\n\nMeeting follow-up\n${request}\n\nDecisions\n[Add the agreed decisions and relevant links.]`,
  };
  return templates[type];
}

export function analyzeTranscript(input) {
  const text = validateTranscript(input);
  const lines = segments(text);
  const titleLine = text.split(/\r?\n/).find((line) => /^(?:Meeting|会议)\s*[:：]/iu.test(line));
  const title = titleLine ? titleLine.replace(/^(?:Meeting|会议)\s*[:：]\s*/iu, '').slice(0,120) : 'Your meeting recap';
  const tasks = [];
  const actionItems = [];
  const decisions = [];
  const content = lines.filter((line) => !/^(?:Meeting|会议)\s*[:：]/iu.test(line));
  const seen = new Set();
  for (const line of content) {
    if (negated.test(line)) continue;
    const body = withoutSpeaker(line);
    if (/\b(?:agreed|decided|decision|will keep)\b|决定|达成一致/iu.test(body)) decisions.push(body);
    if (!commitment.test(line)) continue;
    const kind = patterns.find((candidate) => candidate.test.test(body));
    if (kind) {
      const key = body.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({
        id: `task-${tasks.length + 1}`, type: kind.type, title: kind.title,
        description: body, owner: ownerOf(line), evidence: line, draft: draftFor(kind.type, line),
        estimateMinutes: kind.minutes, status: 'suggested',
      });
    } else if (strategic.test(body)) {
      actionItems.push({ title: body, owner: ownerOf(line), evidence: line });
    }
  }
  const evidence = new Set(tasks.map((task) => task.evidence));
  const summary = content.filter((line) => !evidence.has(line)).slice(0, 3).map(withoutSpeaker);
  return { title, summary, decisions: decisions.slice(0, 5), actionItems: actionItems.slice(0, 10), tasks: tasks.slice(0, 20), mode: 'demo' };
}
