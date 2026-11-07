/**
 * CopilotPanel — ask about this mentorship, and check the answer against its source.
 *
 * ## Model text is never rendered as markup
 *
 * An answer is built from text students wrote, so a hand-in can be written to shape
 * it. Everything it says is rendered as a React string, which the browser treats as
 * text whatever it contains. There is no `dangerouslySetInnerHTML` and no markdown
 * renderer in this path. The only elements are the chips below, which our code makes
 * for handles the response listed. See `lib/copilot.js`.
 *
 * A resource citation goes to its row on this page, not to its URL: that URL is
 * user-supplied, and the row already renders it through the app's one checked path.
 *
 * ## The conversation stays here
 *
 * History is component state. It is not persisted, not sent anywhere and gone on
 * reload, and no question or answer is written to the console.
 *
 * ## Two modes, one panel
 *
 * The server says which (`GET /api/copilot/mode`): S2's answer from search, or the
 * agent, which may also look records up and cites them as `[T1]`. The agent is off
 * unless the server's COPILOT_AGENT setting is on and the agent may run on its
 * database; until the server says `agent`, the panel asks as before.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Button from './Button';
import Card from './Card';
import { Field, Textarea } from './Field';
import FilePreview from './FilePreview';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import { previewKind } from '../lib/attachments';
import { scrollToAnchor } from '../lib/anchors';
import {
  AGENT_REQUEST_TIMEOUT_MS,
  MAX_QUESTION,
  REQUEST_TIMEOUT_MS,
  anchorOf,
  chipLabel,
  isRecord,
  recordChipLabel,
  recordKindOf,
  recordTarget,
  kindOf,
  outcomeOf,
  pagesOf,
  refusalFor,
  shortenPassage,
  splitAnswer
} from '../lib/copilot';
import styles from './CopilotPanel.module.css';

const NOTE = {
  ask: "Sees this mentorship's material only. Answers can be incomplete, so check the cited source.",
  agent:
    "Sees this mentorship's material, and your own work and sessions. Answers can be incomplete, so check the cited source."
};

export default function CopilotPanel({ mentorshipId, status }) {
  const { authFetch } = useAuth();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState([]);
  const [pending, setPending] = useState(false);
  // A ref as well as the state: two clicks in one frame both see the state as it
  // was before either of them, and the ref is what stops the second.
  const sending = useRef(false);
  const nextId = useRef(1);
  // 'ask' until the server says otherwise, and on any failure to ask it.
  const [mode, setMode] = useState('ask');

  useEffect(() => {
    let live = true;
    authFetch('/api/copilot/mode')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body?.mode === 'agent') setMode('agent');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [authFetch]);

  const refusal = refusalFor(status);

  const ask = async (text) => {
    const asked = text.trim();
    if (!asked || asked.length > MAX_QUESTION || sending.current) return;

    sending.current = true;
    setPending(true);
    const id = nextId.current++;
    setTurns((all) => [...all, { id, question: asked, state: 'loading', mode, startedAt: Date.now() }]);
    setQuestion('');

    // The route gives up first; this is for when it never answers at all.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      mode === 'agent' ? AGENT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    );

    let outcome;
    try {
      const route = mode === 'agent' ? 'agent' : 'ask';
      const res = await authFetch(`/api/mentorships/${mentorshipId}/copilot/${route}`, {
        method: 'POST',
        body: JSON.stringify({ question: asked }),
        signal: controller.signal
      });
      outcome = outcomeOf(res.status, await res.json().catch(() => null));
    } catch (err) {
      // The kind of failure only: what was asked stays out of the console.
      console.error('Assistant request failed:', err.name);
      outcome = outcomeOf(0, null);
    } finally {
      clearTimeout(timer);
      sending.current = false;
      setPending(false);
    }

    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...outcome } : t)));
  };

  if (refusal) {
    return (
      <Card title="Ask about this mentorship">
        <p className={styles.refusal}>{refusal}</p>
      </Card>
    );
  }

  const submit = (e) => {
    e.preventDefault();
    ask(question);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(question);
    }
  };

  return (
    <Card title="Ask about this mentorship">
      {/* Announced as each answer arrives. The list is the live region rather than
          each answer, so a screen reader hears additions, not the whole history. */}
      {turns.length > 0 && (
        <ol className={styles.turns} aria-live="polite" aria-relevant="additions text" aria-label="Questions and answers">
          {turns.map((turn) => (
            <Turn
              key={turn.id}
              turn={turn}
              mentorshipId={mentorshipId}
              disabled={pending}
              onRetry={() => ask(turn.question)}
            />
          ))}
        </ol>
      )}

      <form onSubmit={submit} className={styles.form}>
        <Field label="Your question" count={question.length} max={MAX_QUESTION}>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MAX_QUESTION}
            rows={2}
            disabled={pending}
            placeholder="e.g. What did my mentor say about my last hand-in?"
          />
        </Field>
        <div className={styles.formActions}>
          <Button type="submit" variant="primary" disabled={pending || !question.trim()}>
            Ask
          </Button>
        </div>
      </form>

      <p className={styles.note}>{NOTE[mode]}</p>
    </Card>
  );
}

function Turn({ turn, mentorshipId, disabled, onRetry }) {
  return (
    <li className={styles.turn}>
      <p className={styles.question}>
        <span className={styles.you}>You:</span> {turn.question}
      </p>
      {turn.state === 'loading' &&
        (turn.mode === 'agent' ? (
          <AgentProgress startedAt={turn.startedAt} />
        ) : (
          <InlineLoader label="Searching this mentorship's material…" />
        ))}
      {turn.state === 'answered' && (
        <Answer answer={turn.answer} citations={turn.citations} notes={turn.notes} mentorshipId={mentorshipId} />
      )}
      {turn.state === 'abstained' && <p className={styles.abstained}>{turn.message}</p>}
      {turn.state === 'refused' && <p className={styles.refusal}>{turn.message}</p>}
      {['limited', 'unavailable', 'failed', 'stopped'].includes(turn.state) && (
        <div className={styles.problem}>
          <p role="alert">{turn.message}</p>
          <Button size="sm" onClick={onRetry} disabled={disabled}>
            Try again
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * An agent turn takes longer than a search, and has steps the browser cannot see.
 * Rather than a longer spinner: what it is doing, and for how long so far.
 */
function AgentProgress({ startedAt }) {
  // Seconds so far, counted by the interval rather than read from the clock in render.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000);
    return () => clearInterval(tick);
  }, [startedAt]);
  return <InlineLoader label={`Looking through this mentorship's records and material… ${seconds} s`} />;
}

function Answer({ answer, citations, notes = [], mentorshipId }) {
  const [open, setOpen] = useState(null);
  const current = citations.find((c) => c.handle === open);

  return (
    <div>
      <p className={styles.answer}>
        {splitAnswer(answer, citations).map((part, i) =>
          typeof part === 'string' ? (
            part
          ) : (
            <button
              key={`${part.handle}-${i}`}
              type="button"
              className={`${styles.chip} ${open === part.handle ? styles.chipOpen : ''}`}
              aria-label={isRecord(part.citation) ? recordChipLabel(part.citation) : chipLabel(part.citation)}
              aria-expanded={open === part.handle}
              onClick={() => setOpen(open === part.handle ? null : part.handle)}
            >
              {part.handle}
            </button>
          )
        )}
      </p>
      {notes.map((note) => (
        <p key={note} className={styles.sourceWhere}>
          {note}
        </p>
      ))}
      {current &&
        (isRecord(current) ? (
          <RecordCard citation={current} mentorshipId={mentorshipId} />
        ) : (
          <SourceCard citation={current} />
        ))}
    </div>
  );
}

/** A record the agent looked up: what it is, and the way to its row. */
function RecordCard({ citation, mentorshipId }) {
  const [missing, setMissing] = useState(false);
  const target = recordTarget(citation, mentorshipId);
  const kind = recordKindOf(citation);

  return (
    <aside className={styles.source} aria-label={`Record ${citation.handle}`}>
      <p className={styles.sourceTitle}>{citation.title || kind}</p>
      <p className={styles.sourceWhere}>{target?.path ? `${kind} · in another mentorship` : kind}</p>
      {target?.anchor && (
        <Button size="sm" onClick={() => setMissing(!scrollToAnchor(target.anchor))}>
          Go to the {kind}
        </Button>
      )}
      {target?.path && <Link to={target.path}>Open the {kind}</Link>}
      {missing && <p className={styles.sourceWhere}>That isn&apos;t on this page any more.</p>}
    </aside>
  );
}

function SourceCard({ citation }) {
  const { authFetch } = useAuth();
  const toast = useToast();
  const [previewing, setPreviewing] = useState(null);
  const [missing, setMissing] = useState(false);

  const isFile = citation.sourceType === 'attachment' && citation.parentId && citation.attachmentId;
  const pages = pagesOf(citation);
  const path = isFile ? `/api/submissions/${citation.parentId}/files/${citation.attachmentId}` : '';
  const canPreview = isFile && previewKind(citation.title);

  const download = async () => {
    try {
      const res = await authFetch(path);
      if (!res.ok) throw new Error(String(res.status));
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = href;
      a.download = citation.title;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    } catch {
      toast.error('Could not download that file');
    }
  };

  // To the record on this page. Focus goes with it, so the keyboard follows.
  const goToRecord = () => {
    const el = document.getElementById(anchorOf(citation));
    if (!el) {
      setMissing(true);
      return;
    }
    setMissing(false);
    el.setAttribute('tabindex', '-1');
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  };

  return (
    <aside className={styles.source} aria-label={`Source ${citation.handle}`}>
      <p className={styles.sourceTitle}>{citation.title}</p>
      <p className={styles.sourceWhere}>
        {[
          isFile ? citation.parentTitle : kindOf(citation),
          citation.heading && citation.heading !== 'Document' ? citation.heading : null,
          pages
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {citation.passage && <blockquote className={styles.passage}>{shortenPassage(citation.passage)}</blockquote>}

      {isFile && canPreview && (
        <Button size="sm" onClick={() => setPreviewing({ name: citation.title })}>
          {citation.startPage && canPreview === 'pdf' ? `Open at page ${citation.startPage}` : 'Open the file'}
        </Button>
      )}
      {isFile && !canPreview && (
        <Button size="sm" onClick={download}>
          Download the file
        </Button>
      )}
      {!isFile && (
        <Button size="sm" onClick={goToRecord}>
          Go to the {kindOf(citation)}
        </Button>
      )}
      {missing && <p className={styles.sourceWhere}>That isn&apos;t on this page any more.</p>}

      {isFile && canPreview && (
        <FilePreview
          file={previewing}
          path={path}
          page={canPreview === 'pdf' ? citation.startPage : undefined}
          onClose={() => setPreviewing(null)}
        />
      )}
    </aside>
  );
}

