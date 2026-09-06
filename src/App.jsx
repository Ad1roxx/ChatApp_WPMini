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
 * - /users/:id -> Read-only profile of another user
 * - /profile   -> View and edit your own profile
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
import UserProfilePage from "./pages/UserProfilePage";
import AnnouncementsPage from "./pages/AnnouncementsPage";
import AdminPage from "./pages/AdminPage";
import SuspendedPage from "./pages/SuspendedPage";
import MentorshipsPage from "./pages/MentorshipsPage";
import MentorshipDetailPage from "./pages/MentorshipDetailPage";
import { PageLoader } from "./components/Loading";

function App() {
  // Get auth state from our context
  // dbUser is needed for the first-login role gate below
  const { user, dbUser, loading } = useAuth();

  // Show loading spinner while checking auth
  // Without this, user would briefly see login page even if logged in
  if (loading) {
    return <PageLoader label="Signing you in" />;
  }

  // Suspension comes FIRST, before the role gate. A suspended account with no
  // role would otherwise be shown the role picker, which is both useless and
  // misleading — every request it made would be refused anyway.
  if (user && dbUser?.suspended) {
    return <SuspendedPage />;
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
        
        {/* Someone else's profile (read-only) - protected route.
            Declared after /users; React Router matches the static
            segment first, so /users and /users/:id never collide. */}
        <Route
          path="/users/:userId"
          element={user ? <UserProfilePage /> : <Navigate to="/login" />}
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

        {/* Mentorships - protected route. Shows both sides at once: a
            person can be a student in one relationship and a mentor in
            another, and the page reads whichever apply. */}
        <Route
          path="/mentorships"
          element={user ? <MentorshipsPage /> : <Navigate to="/login" />}
        />

        {/* One mentorship and its goals. Declared after the static
            /mentorships, which React Router matches first. */}
        <Route
          path="/mentorships/:id"
          element={user ? <MentorshipDetailPage /> : <Navigate to="/login" />}
        />

        {/* Admin dashboard - protected route.
            Admin-gated in the page and, more importantly, on the server:
            both endpoints behind it are requireRole('admin'). */}
        <Route
          path="/admin"
          element={user ? <AdminPage /> : <Navigate to="/login" />}
        />

        {/* Announcements feed - protected route.
            Everyone can read it; only mentors see the compose box. */}
        <Route
          path="/announcements"
          element={user ? <AnnouncementsPage /> : <Navigate to="/login" />}
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