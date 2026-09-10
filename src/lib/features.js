/**
 * Feature switches.
 *
 * Not a config file and not an experiment framework — one object, edited by
 * hand, for features that are **built and tested but deliberately not part of
 * the product right now**.
 *
 * ## Why a switch rather than deleting the code
 *
 * `sessionRatings` is finished: a model, three endpoints, a `Stars` component
 * and 27 tests. It was cut because a five-star score sits oddly in a
 * two-person mentorship — the number adds very little that the session notes
 * do not already say, and rating the person who is helping you changes the
 * relationship into something more like a marketplace than the app intends.
 *
 * That is a product judgement, not a defect, and it may well be reversed. So
 * the code stays.
 *
 * ## Why the server half stays switched ON
 *
 * Only the UI is hidden. The endpoints stay mounted and their tests keep
 * running, on purpose: **dead code that nothing exercises rots.** If the
 * routes were commented out and the tests skipped, turning this back on in
 * six months would mean debugging three endpoints that had silently drifted
 * out of step with the models around them. Kept live and tested, flipping the
 * switch is the whole job.
 *
 * The endpoints are authenticated and permission-checked like every other
 * one, so nothing is exposed by leaving them reachable — there is simply no
 * button in the product that calls them.
 *
 * To bring it back: set this to `true`. Nothing else.
 */
export const FEATURES = {
  sessionRatings: false
};

export default FEATURES;
