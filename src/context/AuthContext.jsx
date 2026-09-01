/* eslint-disable react-refresh/only-export-components --
 * This file deliberately exports both the AuthProvider component and the
 * useAuth hook. That is the standard React context pattern, and splitting the
 * hook into its own module purely to satisfy Fast Refresh would scatter one
 * coherent piece of the app across two files. The only cost is that editing
 * this file does a full reload instead of a hot update.
 */

/**
 * AuthContext - Manages authentication state across the app
 *
 * What this does:
 * 1. Listens for Firebase Auth changes (login/logout)
 * 2. When user logs in with Google, saves their info to our MongoDB
 * 3. Connects to Socket.IO for real-time features
 * 4. Provides user info and socket to any component that needs it
 * 
 * How to use in components:
 * 
 *   import { useAuth } from '../context/AuthContext';
 *   
 *   function MyComponent() {
 *     const { user, dbUser, socket, loading } = useAuth();
 *     
 *     if (loading) return <Loading />;
 *     if (!user) return <Redirect to="/login" />;
 *     
 *     return <div>Hello, {dbUser.displayName}</div>;
 *   }
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { io } from 'socket.io-client';
import { auth } from '../firebase';

// Create the context (a container for shared data)
const AuthContext = createContext();

// Server URL - where our backend is running
const SERVER_URL = 'http://localhost:3001';

/**
 * Get the current Firebase ID token, or null when signed out.
 *
 * `getIdToken()` returns a cached token and refreshes it automatically when
 * it is close to expiring, so calling this before every request is cheap and
 * means a long session never starts failing with 401s an hour in.
 */
async function getAuthToken() {
  const current = auth.currentUser;
  if (!current) return null;

  try {
    return await current.getIdToken();
  } catch (err) {
    console.error('Could not get auth token:', err);
    return null;
  }
}

/**
 * AuthProvider Component
 * 
 * Wraps the entire app and provides auth state to all children.
 * Think of it as the "source" of auth information.
 */
export function AuthProvider({ children }) {
  // Firebase user (from Google sign-in)
  const [user, setUser] = useState(null);
  
  // Our database user (from MongoDB - has _id, isOnline, etc.)
  const [dbUser, setDbUser] = useState(null);
  
  // Socket.IO connection instance
  const [socket, setSocket] = useState(null);
  
  // Loading state (while checking if user is logged in)
  const [loading, setLoading] = useState(true);

  /**
   * The one way this app talks to the server.
   *
   * Every request carries the Firebase ID token, which the server verifies
   * and turns into an identity. Because of that, callers no longer send their
   * own `_id` to say who they are — the server reads it from the token, so a
   * request cannot claim to be someone else.
   *
   * Takes a PATH ('/api/users'), not a full URL, so no page has to know where
   * the server lives. JSON bodies get their Content-Type set automatically.
   *
   * Wrapped in useCallback with no dependencies beyond the constant
   * SERVER_URL, so its identity is stable and pages can safely list it in an
   * effect's dependency array without re-running on every render.
   */
  const authFetch = useCallback(async (path, options = {}) => {
    const token = await getAuthToken();

    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    return fetch(`${SERVER_URL}${path}`, { ...options, headers });
  }, []);

  /**
   * Effect: Listen for Firebase Auth changes
   * 
   * This runs when:
   * - App first loads (checks if there's a saved login)
   * - User logs in
   * - User logs out
   * 
   * onAuthStateChanged is a Firebase listener that fires whenever
   * the authentication state changes.
   */
  useEffect(() => {
    // Subscribe to auth changes
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      console.log('Auth state changed:', firebaseUser?.email || 'No user');
      
      if (firebaseUser) {
        // User is logged in with Google
        setUser(firebaseUser);
        
        try {
          // Register/update user in our MongoDB database.
          //
          // The uid and email are no longer sent: the server takes those from
          // the verified token. Name and photo are still sent because they are
          // cosmetic and the token's copies can lag behind a Google profile
          // change.
          const token = await firebaseUser.getIdToken();

          const response = await fetch(`${SERVER_URL}/api/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL
            })
          });

          if (response.ok) {
            const userData = await response.json();
            setDbUser(userData);
            console.log('User registered in DB:', userData.displayName);

            // Connect to Socket.IO, authenticated at the handshake.
            //
            // The token goes in `auth`, which Socket.IO sends once when the
            // connection opens. The server verifies it there and pins the
            // identity to the socket for its whole life, which is why the
            // events below no longer carry a senderId — a client can't claim
            // to be someone else on a connection that already knows who it is.
            const newSocket = io(SERVER_URL, {
              transports: ['websocket', 'polling'],  // WebSocket first, fallback to polling
              auth: { token }
            });

            newSocket.on('connect', () => {
              console.log('Socket connected:', newSocket.id);
              // Server reads our identity from the handshake, so this carries
              // no payload — it just says "I'm here".
              newSocket.emit('user-online');
            });

            newSocket.on('connect_error', (err) => {
              // Most likely an expired token: the page has been open longer
              // than the token's hour. Reconnecting mints a fresh one.
              console.error('Socket connection refused:', err.message);
            });

            newSocket.on('disconnect', () => {
              console.log('Socket disconnected');
            });

            setSocket(newSocket);
          } else {
            console.error('Failed to register user in DB');
          }
        } catch (err) {
          console.error('Error connecting to server:', err);
        }
      } else {
        // User is logged out
        setUser(null);
        setDbUser(null);
        
        // Disconnect socket if it exists.
        //
        // This reads the socket through the state UPDATER rather than the
        // `socket` variable. That variable is captured by this callback from
        // the render in which the effect ran — and since the effect runs once
        // on mount, it is captured as null forever. `if (socket)` was
        // therefore never true here and the socket was never disconnected on
        // this path. (The explicit logout() below was unaffected: it is
        // recreated every render, so it sees the current value.)
        //
        // The updater form always receives the latest value, which is why it
        // also needs no dependency on `socket` — keeping the effect's
        // run-once-on-mount contract intact.
        setSocket((current) => {
          if (current) current.disconnect();
          return null;
        });
      }
      
      setLoading(false);
    });

    // Cleanup: unsubscribe when component unmounts
    return () => unsubscribe();
  }, []);  // Empty dependency array = run once on mount

  /**
   * Logout function
   * 
   * Signs out from Firebase and cleans up socket
   */
  const logout = async () => {
    try {
      if (socket) {
        socket.disconnect();
      }
      await signOut(auth);
      setUser(null);
      setDbUser(null);
      setSocket(null);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  /**
   * Set the current user's role ('student' or 'mentor').
   *
   * Two callers, same operation:
   * - the first-login picker. On success dbUser gains a role, so App
   *   re-renders out of the picker and into the normal routes.
   * - the role switcher on the profile page, for changing it later.
   *
   * Returns true/false so the caller can report failure instead of looking
   * like nothing happened.
   */
  const chooseRole = async (role) => {
    if (!dbUser) return false;
    try {
      const response = await authFetch(`/api/users/${dbUser._id}/role`, {
        method: 'POST',
        body: JSON.stringify({ role })
      });
      if (response.ok) {
        setDbUser(await response.json());
        return true;
      }
      console.error('Failed to set role');
      return false;
    } catch (err) {
      console.error('Error choosing role:', err);
      return false;
    }
  };

  /**
   * Update the current user's profile.
   *
   * `fields` may contain bio (everyone) and, for mentors, expertise and
   * availability. The server ignores mentor-only fields for students.
   * Returns true/false so the page can show success or error feedback.
   */
  const updateProfile = async (fields) => {
    if (!dbUser) return false;
    try {
      const response = await authFetch(`/api/users/${dbUser._id}/profile`, {
        method: 'PUT',
        body: JSON.stringify(fields)
      });
      if (response.ok) {
        setDbUser(await response.json());
        return true;
      }
      console.error('Failed to update profile');
      return false;
    } catch (err) {
      console.error('Error updating profile:', err);
      return false;
    }
  };

  // The value object that will be available to all children
  const value = {
    user,       // Firebase user (has uid, email from Google)
    dbUser,     // MongoDB user (has _id, isOnline, role, etc.)
    socket,     // Socket.IO connection
    loading,    // True while checking auth state
    logout,        // Function to sign out
    authFetch,     // Authenticated fetch — the only way to call the server
    chooseRole,    // Set role at first login, or change it later
    updateProfile, // Save profile fields (bio / expertise / availability)
    SERVER_URL     // Kept for anything that needs the raw origin
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth Hook
 * 
 * Custom hook to access auth context from any component.
 * Must be used inside an AuthProvider.
 * 
 * Example:
 *   const { user, logout } = useAuth();
 */
export function useAuth() {
  const context = useContext(AuthContext);
  
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  
  return context;
}
