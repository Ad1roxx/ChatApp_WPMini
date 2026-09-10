/**
 * Resources — the links shared inside a mentorship
 *
 * "That article you sent me" is the single most common thing to lose in a
 * conversation. A chat transcript is a bad place to keep anything you intend
 * to come back to, so links get pinned here instead.
 *
 * Either party can add one, like sessions and unlike goals — a student
 * finding something useful and pinning it for their mentor is the same act as
 * the reverse, and there is nothing to approve.
 *
 * Links only, not uploads. Storage, size limits and virus scanning are a bill
 * this project does not have, almost everything a mentor shares already lives
 * at a URL, and a dead link is visibly dead where a missing upload just looks
 * like a bug.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import Card from './Card';
import Button from './Button';
import { Field, Input, Textarea } from './Field';
import ConfirmDialog from './ConfirmDialog';
import EmptyState from './EmptyState';
import { InlineLoader } from './Loading';
import { useToast } from './Toast';
import { LinkIcon } from './Icons';
import styles from './Resources.module.css';

/**
 * The hostname, for the line under the title.
 *
 * A bare domain tells you more about where a link goes than a truncated URL
 * does, and it is what a reader is actually checking before they click.
 * Anything unparseable falls back to the raw string rather than throwing —
 * the server only stores http(s), so this is belt-and-braces.
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function Resources({ mentorshipId, active, isMentor }) {
  const { dbUser, socket, authFetch } = useAuth();
  const toast = useToast();

  const [resources, setResources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const [removing, setRemoving] = useState(null);

  useEffect(() => {
    let stale = false;

    const load = async () => {
      try {
        const res = await authFetch(`/api/mentorships/${mentorshipId}/resources`);
        if (res.ok && !stale) setResources(await res.json());
      } catch (err) {
        console.error('Error loading resources:', err);
      } finally {
        if (!stale) setLoading(false);
      }
    };

    load();
    return () => {
      stale = true;
    };
  }, [mentorshipId, authFetch]);

  useEffect(() => {
    if (!socket) return undefined;

    const handleAdded = (resource) => {
      if (String(resource.mentorship) !== mentorshipId) return;
      setResources((prev) =>
        prev.some((r) => r._id === resource._id) ? prev : [resource, ...prev]
      );
    };

    const handleRemoved = ({ _id, mentorship }) => {
      if (String(mentorship) !== mentorshipId) return;
      setResources((prev) => prev.filter((r) => r._id !== _id));
    };

    socket.on('resource-added', handleAdded);
    socket.on('resource-removed', handleRemoved);

    return () => {
      socket.off('resource-added', handleAdded);
      socket.off('resource-removed', handleRemoved);
    };
  }, [socket, mentorshipId]);

  const share = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      const res = await authFetch(`/api/mentorships/${mentorshipId}/resources`, {
        method: 'POST',
        body: JSON.stringify({ title, url, note })
      });

      if (res.ok) {
        const resource = await res.json();
        setResources((prev) => [resource, ...prev]);
        setTitle('');
        setUrl('');
        setNote('');
        setFormOpen(false);
        toast.success('Link shared');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Could not share that link');
      }
    } catch (err) {
      console.error('Error sharing resource:', err);
      toast.error('Could not reach the server');
    } finally {
      setSaving(false);
    }
  };

  const remove = useCallback(
    async (resource) => {
      setBusyId(resource._id);

      try {
        const res = await authFetch(`/api/resources/${resource._id}`, {
          method: 'DELETE'
        });

        if (res.ok) {
          setResources((prev) => prev.filter((r) => r._id !== resource._id));
          toast.success('Link removed');
        } else {
          const err = await res.json().catch(() => ({}));
          toast.error(err.error || 'Could not remove that link');
        }
      } catch (err) {
        console.error('Error removing resource:', err);
        toast.error('Could not reach the server');
      } finally {
        setBusyId(null);
      }
    },
    [authFetch, toast]
  );

  if (loading) {
    return (
      <Card title="Resources">
        <InlineLoader label="Loading resources" />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Resources"
        subtitle={
          resources.length > 0
            ? `${resources.length} link${resources.length === 1 ? '' : 's'} shared`
            : undefined
        }
        actions={
          active && (
            <Button
              size="sm"
              variant={formOpen ? 'secondary' : 'primary'}
              onClick={() => setFormOpen((open) => !open)}
            >
              {formOpen ? 'Cancel' : 'Share a link'}
            </Button>
          )
        }
      >
        {formOpen && (
          <form onSubmit={share} className={styles.form}>
            <Field label="What is it?">
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. The paper on consistent hashing"
                maxLength={200}
                autoFocus
              />
            </Field>

            <Field label="Link" hint="http or https">
              {/* type="url" so a phone offers the right keyboard, and the
                  browser catches the obvious mistakes before the server has
                  to. The server validates it again regardless. */}
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                maxLength={2000}
              />
            </Field>

            <Field label="Why is it worth reading?" hint="Optional">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What to look at, or which part matters"
                maxLength={500}
                rows={2}
              />
            </Field>

            <div className={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!title.trim() || !url.trim()}
              >
                {saving ? 'Sharing' : 'Share'}
              </Button>
            </div>
          </form>
        )}

        {resources.length === 0 && !formOpen && (
          <EmptyState
            icon={<LinkIcon size={20} />}
            title="Nothing shared yet"
            description={
              active
                ? 'Pin the links worth coming back to, so they do not scroll away in the chat.'
                : 'This mentorship is not active, so nothing new can be shared.'
            }
            action={
              active ? (
                <Button variant="primary" onClick={() => setFormOpen(true)}>
                  Share a link
                </Button>
              ) : undefined
            }
          />
        )}

        {resources.length > 0 && (
          <ul className={styles.list}>
            {resources.map((resource) => {
              const mine = (resource.addedBy?._id || resource.addedBy) === dbUser?._id;

              return (
                <li key={resource._id} className={styles.row}>
                  <span className={styles.icon} aria-hidden="true">
                    <LinkIcon size={16} />
                  </span>

                  <div className={styles.body}>
                    {/* `noopener` because a link opened with target=_blank
                        otherwise hands the new page a reference back to this
                        one; `noreferrer` so a shared link does not leak the
                        mentorship URL it was shared from. */}
                    <a
                      href={resource.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.title}
                    >
                      {resource.title}
                    </a>

                    <span className={styles.meta}>
                      {hostOf(resource.url)}
                      <span className={styles.who}>
                        {' · '}
                        {mine ? 'you' : resource.addedBy?.displayName || 'someone'}
                      </span>
                    </span>

                    {resource.note && <p className={styles.note}>{resource.note}</p>}
                  </div>

                  {/* The server decides; this only avoids offering a button
                      that would be refused. Whoever shared it may remove it,
                      and so may the mentor — a student cannot take down their
                      mentor's links. */}
                  {(mine || isMentor) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === resource._id}
                      onClick={() => setRemoving(resource)}
                      className={styles.remove}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this link?"
        description="It disappears for both of you. The page it points at is untouched."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          const target = removing;
          setRemoving(null);
          await remove(target);
        }}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
