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
import GroupsPage from "./pages/GroupsPage";
import GroupChatPage from "./pages/GroupChatPage";
import RoleSelectPage from "./pages/RoleSelectPage";
import ProfilePage from "./pages/ProfilePage";

function App() {
  // Get auth state from our context
  // dbUser is needed for the first-login role gate below
  const { user, dbUser, loading } = useAuth();

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

  // First-login role selection. A signed-in user whose account has no role
  // yet must pick one before using the app. dbUser is null for a moment right
  // after login while we fetch it, so we only gate once it has loaded AND
  // confirms no role — this never blocks prematurely.
  if (user && dbUser && !dbUser.role) {
    return <RoleSelectPage />;
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

        {/* Own profile - protected route */}
        <Route
          path="/profile"
          element={user ? <ProfilePage /> : <Navigate to="/login" />}
        />

        {/* Groups list / create - protected route */}
        <Route
          path="/groups"
          element={user ? <GroupsPage /> : <Navigate to="/login" />}
        />

        {/* Group chat - protected route */}
        <Route
          path="/group/:groupId"
          element={user ? <GroupChatPage /> : <Navigate to="/login" />}
        />

        {/* Catch-all - redirect to home */}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;