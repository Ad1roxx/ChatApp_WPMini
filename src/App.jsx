/**
 * App Component - Main routing
 * 
 * This sets up all the pages/routes in our app.
 * Uses our custom useAuth hook to check if user is logged in.
 * 
 * Routes:
 * - /         -> Home (redirects to /users if logged in)
 * - /login    -> Google sign-in page
 * - /users    -> List of users to chat with
 * - /chat/:id -> Chat with a specific user
 */

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";

import LoginPage from "./pages/LoginPage";
import UsersPage from "./pages/UsersPage";
import ChatPage from "./pages/ChatPage";

function App() {
  // Get auth state from our context
  const { user, loading } = useAuth();

  // Show loading spinner while checking auth
  // Without this, user would briefly see login page even if logged in
  if (loading) {
    return (
      <div style={{ 
        height: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: '#f5f5f5'
      }}>
        <div style={{ 
          width: '40px', 
          height: '40px', 
          border: '3px solid #e0e0e0',
          borderTopColor: '#3b82f6',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }} />
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Home - redirect based on auth status */}
        <Route 
          path="/" 
          element={user ? <Navigate to="/users" /> : <Navigate to="/login" />} 
        />
        
        {/* Login page - redirect to users if already logged in */}
        <Route 
          path="/login" 
          element={user ? <Navigate to="/users" /> : <LoginPage />} 
        />
        
        {/* Users list - protected route (needs login) */}
        <Route 
          path="/users" 
          element={user ? <UsersPage /> : <Navigate to="/login" />} 
        />
        
        {/* Chat page - protected route */}
        <Route 
          path="/chat/:peerId" 
          element={user ? <ChatPage /> : <Navigate to="/login" />} 
        />
        
        {/* Catch-all - redirect to home */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;