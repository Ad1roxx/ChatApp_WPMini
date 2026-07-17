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

import { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { io } from 'socket.io-client';
import { auth } from '../firebase';

// Create the context (a container for shared data)
const AuthContext = createContext();

// Server URL - where our backend is running
const SERVER_URL = 'http://localhost:3001';

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
          // Register/update user in our MongoDB database
          const response = await fetch(`${SERVER_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              firebaseUid: firebaseUser.uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL
            })
          });

          if (response.ok) {
            const userData = await response.json();
            setDbUser(userData);
            console.log('User registered in DB:', userData.displayName);

            // Connect to Socket.IO
            // We pass the MongoDB _id so the server knows who this socket belongs to
            const newSocket = io(SERVER_URL, {
              transports: ['websocket', 'polling']  // Try WebSocket first, fallback to polling
            });

            newSocket.on('connect', () => {
              console.log('Socket connected:', newSocket.id);
              // Tell server this user is online
              newSocket.emit('user-online', userData._id);
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
        
        // Disconnect socket if it exists
        if (socket) {
          socket.disconnect();
          setSocket(null);
        }
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

  // The value object that will be available to all children
  const value = {
    user,       // Firebase user (has uid, email from Google)
    dbUser,     // MongoDB user (has _id, isOnline, etc.)
    socket,     // Socket.IO connection
    loading,    // True while checking auth state
    logout,     // Function to sign out
    SERVER_URL  // So components can make API calls
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
