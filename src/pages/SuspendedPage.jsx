/**
 * SuspendedPage - what a suspended account sees instead of the app
 *
 * Gated in App.jsx before the routes, so there is no page a suspended user
 * can reach. That is presentation only — the server refuses every request
 * from them regardless, and their socket is disconnected the moment they are
 * suspended.
 *
 * `/api/auth/login` deliberately still succeeds for a suspended account, and
 * this screen is why: without it the app could only fail silently, and
 * somebody locked out with no explanation has no idea whether they are
 * banned or the server is down.
 */

import { useAuth } from '../context/AuthContext';
import Button from '../components/Button';
import styles from './SuspendedPage.module.css';

export default function SuspendedPage() {
  const { dbUser, logout } = useAuth();

  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">M</span>
          <span className={styles.brandName}>MentorConnect</span>
        </div>

        <h1 className={styles.title}>Your account is suspended</h1>

        <p className={styles.lede}>
          An administrator has suspended this account, so you can&rsquo;t send
          messages, join groups or read announcements while it stands.
        </p>

        {/* Only shown when a reason was recorded — an empty quote block would
            read as though something had been withheld. */}
        {dbUser?.suspendedReason && (
          <div className={styles.reason}>
            <p className={styles.reasonLabel}>Reason given</p>
            <p className={styles.reasonText}>{dbUser.suspendedReason}</p>
          </div>
        )}

        <p className={styles.next}>
          If you think this is a mistake, contact an administrator. Your
          messages and groups are untouched and will be there if the
          suspension is lifted.
        </p>

        <Button variant="secondary" onClick={logout}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
