/**
 * Who a sign-in is, decided from the verified token alone.
 *
 * The email is the account's identity (it is unique) and the key into the admin
 * allowlist. Sign-in used to fall back to an email in the request body when the
 * token carried none, and never looked at `email_verified` (the audit, F5). With
 * Google sign-in only that could not be reached; with any other Firebase method
 * switched on (anonymous, phone, email and password) a caller could have named an
 * allowlisted address and been made an admin, or taken someone else's address
 * before they arrived. So: the token's email, verified, or no sign-in. The body
 * is not an argument here, which is the point.
 */

/** `{ firebaseUid, email, admin }`, or `{ error, status }`. `adminEmails` are lower-case. */
function loginIdentity(firebaseUser, adminEmails = []) {
  const uid = firebaseUser && typeof firebaseUser.uid === 'string' ? firebaseUser.uid : '';
  const email = firebaseUser && typeof firebaseUser.email === 'string' ? firebaseUser.email.trim().toLowerCase() : '';

  if (!uid || !email) {
    return { error: 'Sign in with an account that has an email address', status: 400 };
  }
  if (firebaseUser.emailVerified !== true) {
    return { error: 'Verify your email address, then sign in again', status: 403 };
  }

  return { firebaseUid: uid, email, admin: adminEmails.includes(email) };
}

/** A display name or photo address from the client or the token: a string, bounded, or ''. */
function cosmetic(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

module.exports = { loginIdentity, cosmetic };
