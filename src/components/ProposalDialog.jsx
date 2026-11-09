/**
 * ProposalDialog — the one place a person approves something the assistant proposed.
 *
 * ## What it shows is what runs
 *
 * The heading and fields come from the signed proposal, and the request is built by
 * lib/agentActions.js from the same token. Everything is rendered as a React string:
 * no markup, no links. A link is shown as its whole text, because the realistic way to
 * misuse this is a URL that carries something out, and a person can only refuse what
 * they can read.
 *
 * ## Once
 *
 * A ref as well as the state: two clicks in one frame both see the state from before
 * either of them, and the ref is what stops the second. The server's claim stops
 * anything that gets past this.
 *
 * ## Only our own sentences
 *
 * The progress and the outcome are ours, chosen by status in lib/agentActions.js.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Button from './Button';
import { InlineLoader } from './Loading';
import { OUTCOMES, approveProposal, dismissProposal, readProposal } from '../lib/agentActions';
import styles from './CopilotPanel.module.css';

export default function ProposalDialog({ token, onDone }) {
  const { authFetch } = useAuth();
  const proposal = useMemo(() => readProposal(token), [token]);
  const acted = useRef(false);
  const [phase, setPhase] = useState('open'); // open | working | settled
  const [expired, setExpired] = useState(() => !proposal || Date.now() >= proposal.expiresAt);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    if (!proposal || expired) return undefined;
    const timer = setTimeout(() => setExpired(true), Math.max(0, proposal.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [proposal, expired]);

  const settle = async (run, { changed = false } = {}) => {
    if (acted.current) return;
    acted.current = true;
    setPhase('working');
    const out = await run();
    setOutcome(out);
    setPhase('settled');
    if (changed && out.state === 'done') onDone?.();
  };

  if (!proposal) return <p className={styles.refusal}>{OUTCOMES.failed}</p>;

  const approve = () => {
    if (Date.now() >= proposal.expiresAt) {
      setExpired(true);
      return undefined;
    }
    return settle(() => approveProposal(authFetch, token), { changed: true });
  };
  const dismiss = () => settle(() => dismissProposal(authFetch, token));
  const stale = expired && phase === 'open';

  return (
    <section className={styles.proposal} aria-label="Proposed change">
      <h3 className={styles.proposalHeading}>{proposal.heading}</h3>
      <p className={styles.proposalAsked}>
        <span className={styles.proposalLabel}>You asked:</span> {proposal.asked}
      </p>
      <dl className={styles.proposalFields}>
        {proposal.fields.map((f, i) => (
          <div key={`${i}-${f.label}`} className={styles.proposalField}>
            <dt className={styles.proposalLabel}>{f.label}</dt>
            <dd className={styles.proposalValue}>{f.value === '' ? <span className={styles.proposalNone}>None</span> : f.value}</dd>
          </div>
        ))}
      </dl>

      {phase === 'open' && !stale && (
        <>
          <p className={styles.proposalNote}>Nothing happens unless you approve it. Check every detail first.</p>
          <div className={styles.proposalActions}>
            <Button variant="primary" onClick={approve}>
              Approve
            </Button>
            <Button onClick={dismiss}>Dismiss</Button>
          </div>
        </>
      )}
      {stale && <p className={styles.refusal}>{OUTCOMES.expired}</p>}
      {phase === 'working' && (
        <div className={styles.proposalActions}>
          <Button variant="primary" disabled>
            Approve
          </Button>
          <InlineLoader label="Working on it…" />
        </div>
      )}
      {phase === 'settled' && (
        <p className={outcome.state === 'done' || outcome.state === 'dismissed' ? styles.proposalOutcome : styles.refusal} role="status">
          {outcome.message}
        </p>
      )}
    </section>
  );
}
