/**
 * A user's own progress figures.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const Mentorship = require('../models/Mentorship');
const Goal = require('../models/Goal');
const Session = require('../models/Session');
const Submission = require('../models/Submission');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app } = require('../app');

// ============================================
// ANALYTICS
// ============================================

/**
 * GET /api/analytics/me
 *
 * What your mentorships add up to. Goals and sessions have been accumulating
 * real data for a while now with nothing reading it back, and the question a
 * mentor with four students actually has is not "how many goals exist" — it is
 * **"which of them has gone quiet?"** That is what the per-mentorship rows are
 * for, and it is the reason this endpoint returns a list rather than a
 * scoreboard.
 *
 * ## Why aggregation rather than a loop
 *
 * Counting in JavaScript would mean pulling every goal — milestone arrays and
 * all — over the wire to look at a boolean on each one. `$group` with `$reduce`
 * does the counting where the data already is and returns one small row per
 * mentorship. At this project's scale either would be instant; the pipeline is
 * the one that stays instant.
 *
 * ## What is deliberately excluded
 *
 * - **Archived goals contribute no milestones.** A goal you gave up on would
 *   otherwise drag the completion figure down forever, and "we decided not to
 *   do this" is not the same as "this is unfinished".
 * - **Ended mentorships are counted in the totals but get no row.** The rows
 *   are a worklist; a finished relationship is not work.
 */
app.get('/api/analytics/me', requireAuth, async (req, res) => {
  try {
    const me = req.authUser._id;
    const now = new Date();

    const mentorships = await Mentorship.find({
      $or: [{ mentor: me }, { student: me }]
    })
      .populate('mentor', 'displayName photoURL role verified')
      .populate('student', 'displayName photoURL role verified');

    const activeIds = mentorships
      .filter((m) => m.status === 'active')
      .map((m) => m._id);

    // Nothing to aggregate over — return the shape anyway rather than a 404,
    // so the page renders its empty state instead of an error.
    const [goalRows, sessionRows] = activeIds.length
      ? await Promise.all([
          Goal.aggregate([
            { $match: { mentorship: { $in: activeIds } } },
            {
              $group: {
                _id: '$mentorship',
                goals: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                },
                archived: {
                  $sum: { $cond: [{ $eq: ['$status', 'archived'] }, 1, 0] }
                },
                milestonesTotal: {
                  $sum: {
                    $cond: [
                      { $ne: ['$status', 'archived'] },
                      { $size: '$milestones' },
                      0
                    ]
                  }
                },
                milestonesDone: {
                  $sum: {
                    $cond: [
                      { $ne: ['$status', 'archived'] },
                      {
                        $size: {
                          $filter: {
                            input: '$milestones',
                            cond: '$$this.done'
                          }
                        }
                      },
                      0
                    ]
                  }
                }
              }
            }
          ]),
          Session.aggregate([
            { $match: { mentorship: { $in: activeIds } } },
            {
              $group: {
                _id: '$mentorship',
                completed: {
                  $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                },
                cancelled: {
                  $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
                },
                minutesMet: {
                  $sum: {
                    $cond: [
                      { $eq: ['$status', 'completed'] },
                      '$durationMinutes',
                      0
                    ]
                  }
                },
                // $min and $max ignore the nulls the $cond produces for rows
                // that do not qualify, which is exactly the behaviour wanted:
                // "the latest one that happened" and "the soonest one still to".
                lastMetAt: {
                  $max: {
                    $cond: [
                      { $eq: ['$status', 'completed'] },
                      '$scheduledFor',
                      null
                    ]
                  }
                },
                nextAt: {
                  $min: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$status', ['proposed', 'confirmed']] },
                          { $gte: ['$scheduledFor', now] }
                        ]
                      },
                      '$scheduledFor',
                      null
                    ]
                  }
                }
              }
            }
          ])
        ])
      : [[], []];

    const goalsBy = new Map(goalRows.map((r) => [String(r._id), r]));
    const sessionsBy = new Map(sessionRows.map((r) => [String(r._id), r]));

    const rows = mentorships
      .filter((m) => m.status === 'active')
      .map((m) => {
        const isMentor = String(m.mentor._id) === String(me);
        const g = goalsBy.get(String(m._id));
        const s = sessionsBy.get(String(m._id));

        return {
          _id: m._id,
          topic: m.topic,
          isMentor,
          startedAt: m.respondedAt || m.requestedAt,
          other: isMentor ? m.student : m.mentor,
          goals: { total: g?.goals || 0, completed: g?.completed || 0 },
          milestones: {
            done: g?.milestonesDone || 0,
            total: g?.milestonesTotal || 0
          },
          sessions: {
            completed: s?.completed || 0,
            cancelled: s?.cancelled || 0,
            minutesMet: s?.minutesMet || 0
          },
          lastMetAt: s?.lastMetAt || null,
          nextAt: s?.nextAt || null
        };
      })
      // Quietest first. The row you need to act on should not be the one you
      // have to scroll to find.
      .sort((a, b) => {
        const at = a.lastMetAt ? new Date(a.lastMetAt).getTime() : 0;
        const bt = b.lastMetAt ? new Date(b.lastMetAt).getTime() : 0;
        return at - bt;
      });

    /**
     * Two streaks, both about work handed in AS A STUDENT — a mentor who set
     * the work handed nothing in, and their figures stay at zero.
     *
     * `onTime` walks the assignments in deadline order and counts the run of
     * hand-ins that beat their deadline. A late one, or one whose deadline
     * passed with nothing handed in, breaks it. Work not yet due is skipped
     * rather than treated as a break: an assignment due next week is not yet
     * either a success or a failure, and counting it as one would make the
     * streak fall every time a mentor set something.
     *
     * `weeks` counts consecutive weeks holding at least one hand-in, late or
     * not — "did you keep showing up" rather than "were you punctual". This
     * week having nothing in it yet does not break the run; a whole empty
     * week does.
     */
    const submissions = await Submission.find({ student: me })
      .select('submittedAt assignment')
      .populate('assignment', 'dueAt');

    const decided = submissions
      .filter((x) => x.assignment)
      .map((x) => ({
        due: new Date(x.assignment.dueAt).getTime(),
        at: x.submittedAt ? new Date(x.submittedAt).getTime() : null
      }))
      // Not handed in and not yet due: no verdict, so it takes no part.
      .filter((x) => x.at !== null || x.due < now.getTime())
      .sort((a, b) => a.due - b.due);

    let onTimeCurrent = 0;
    let onTimeBest = 0;
    for (const x of decided) {
      if (x.at !== null && x.at <= x.due) {
        onTimeCurrent += 1;
        onTimeBest = Math.max(onTimeBest, onTimeCurrent);
      } else {
        onTimeCurrent = 0;
      }
    }

    // Weeks run Monday to Sunday in UTC, so the figure does not shift with
    // the reader's timezone the way a local midnight boundary would.
    const WEEK = 7 * 86400000;
    const weekOf = (ms) => {
      const d = new Date(ms);
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      return (
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        sinceMonday * 86400000
      );
    };

    const weeksHandedIn = new Set(
      submissions
        .filter((x) => x.submittedAt)
        .map((x) => weekOf(new Date(x.submittedAt).getTime()))
    );

    const thisWeek = weekOf(now.getTime());
    let weeks = 0;
    let cursor = weeksHandedIn.has(thisWeek) ? thisWeek : thisWeek - WEEK;
    while (weeksHandedIn.has(cursor)) {
      weeks += 1;
      cursor -= WEEK;
    }

    const sum = (list, pick) => list.reduce((n, x) => n + pick(x), 0);

    res.json({
      totals: {
        mentorships: {
          active: activeIds.length,
          ended: mentorships.filter((m) => m.status === 'ended').length,
          asMentor: mentorships.filter(
            (m) => m.status === 'active' && String(m.mentor._id) === String(me)
          ).length,
          asStudent: mentorships.filter(
            (m) => m.status === 'active' && String(m.student._id) === String(me)
          ).length
        },
        goals: {
          total: sum(rows, (r) => r.goals.total),
          completed: sum(rows, (r) => r.goals.completed)
        },
        milestones: {
          done: sum(rows, (r) => r.milestones.done),
          total: sum(rows, (r) => r.milestones.total)
        },
        sessions: {
          completed: sum(rows, (r) => r.sessions.completed),
          cancelled: sum(rows, (r) => r.sessions.cancelled),
          minutesMet: sum(rows, (r) => r.sessions.minutesMet)
        }
      },
      // Derived on read, like everything else here. Nothing about a streak is
      // stored, so none of it can drift out of step with the hand-ins.
      streaks: {
        handedIn: submissions.filter((x) => x.submittedAt).length,
        onTime: { current: onTimeCurrent, best: onTimeBest },
        weeks
      },
      mentorships: rows
    });
  } catch (err) {
    console.error('Error building analytics:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
