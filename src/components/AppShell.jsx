/**
 * AppShell — the persistent frame every signed-in screen sits inside.
 *
 * Replaces the per-page blue header bar with a role-aware sidebar. That's the
 * single biggest structural UI change: a sidebar that names the sections
 * tells you what the product *is* the moment you land, where a row of
 * "Profile / Notices / Groups / Logout" buttons in a coloured bar tells you
 * only that some pages exist.
 *
 * Layout:
 * - ≥900px: fixed 232px sidebar, content offset beside it.
 * - <900px: sidebar becomes an overlay drawer behind a hamburger, and a
 *   compact top bar carries the page title.
 *
 * The nav is built from a role-filtered list rather than duplicated per role,
 * so adding "Find a Mentor" for students later is one array entry with a
 * `roles` key — not another branch in the JSX.
 *
 * Pages that want the full viewport (the chat transcript, which manages its
 * own scrolling) pass `variant="flush"` to skip the padded content column.
 */

import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Avatar from './Avatar';
import { RoleBadge } from './Badge';
import {
  AnnouncementIcon,
  ChevronLeftIcon,
  CloseIcon,
  GroupsIcon,
  LogOutIcon,
  MenuIcon,
  MessagesIcon,
  ProfileIcon
} from './Icons';
import styles from './AppShell.module.css';

/**
 * `roles: undefined` means "everyone". A future mentor-only entry is just
 * `roles: ['mentor']` here — no new branch anywhere else.
 */
const NAV_SECTIONS = [
  {
    label: null,
    items: [
      { to: '/users', label: 'Messages', icon: MessagesIcon },
      { to: '/groups', label: 'Groups', icon: GroupsIcon },
      { to: '/announcements', label: 'Announcements', icon: AnnouncementIcon }
    ]
  },
  {
    label: 'Account',
    items: [{ to: '/profile', label: 'Profile', icon: ProfileIcon }]
  }
];

export default function AppShell({
  title,
  subtitle,
  actions,
  // Detail screens (a chat, someone's profile) pass the route to return to.
  // The sidebar shows where you are among the top-level sections but not how
  // you got to a nested screen, so those still need an explicit way back.
  backTo,
  variant = 'default',
  children
}) {
  const { dbUser, logout } = useAuth();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const role = dbUser?.role;

  // Escape closes the drawer — expected of anything overlay-shaped.
  useEffect(() => {
    if (!drawerOpen) return;

    const onKeyDown = (e) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const sidebar = (
    <div className={styles.sidebarInner}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          M
        </span>
        <span className={styles.brandName}>MentorConnect</span>
      </div>

      <nav className={styles.nav} aria-label="Main">
        {NAV_SECTIONS.map((section, i) => {
          const items = section.items.filter(
            (item) => !item.roles || (role && item.roles.includes(role))
          );
          if (items.length === 0) return null;

          return (
            <div key={section.label ?? i} className={styles.navSection}>
              {section.label && <p className={styles.navLabel}>{section.label}</p>}
              {items.map(({ to, label, icon: NavIcon }) => (
                <NavLink
                  key={to}
                  to={to}
                  // Close the drawer here rather than in an effect watching
                  // the route. Every way of navigating out of the drawer goes
                  // through one of these links, so the event handler is both
                  // sufficient and more direct than syncing state to the URL.
                  onClick={() => setDrawerOpen(false)}
                  className={({ isActive }) =>
                    [styles.navItem, isActive ? styles.navItemActive : ''].filter(Boolean).join(' ')
                  }
                >
                  <NavIcon size={17} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      <div className={styles.sidebarFooter}>
        <div className={styles.account}>
          <Avatar src={dbUser?.photoURL} name={dbUser?.displayName} size="sm" />
          <div className={styles.accountText}>
            <span className={styles.accountName}>{dbUser?.displayName || 'Signed in'}</span>
            <RoleBadge role={role} />
          </div>
        </div>
        <button type="button" onClick={handleLogout} className={styles.signOut}>
          <LogOutIcon size={16} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className={styles.shell}>
      {/* Desktop sidebar */}
      <aside className={styles.sidebar}>{sidebar}</aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <>
          <button
            type="button"
            className={styles.scrim}
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          />
          <aside className={styles.drawer}>{sidebar}</aside>
        </>
      )}

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.menuButton}
            onClick={() => setDrawerOpen((open) => !open)}
            aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={drawerOpen}
          >
            {drawerOpen ? <CloseIcon size={20} /> : <MenuIcon size={20} />}
          </button>

          {backTo && (
            <button
              type="button"
              onClick={() => navigate(backTo)}
              className={styles.backButton}
              aria-label="Go back"
            >
              <ChevronLeftIcon size={18} />
            </button>
          )}

          <div className={styles.titleGroup}>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>

          {actions && <div className={styles.topbarActions}>{actions}</div>}
        </header>

        <main className={variant === 'flush' ? styles.contentFlush : styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
