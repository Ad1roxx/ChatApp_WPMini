import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthState } from "react-firebase-hooks/auth";
import { auth } from "./firebase";

import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ChatPage from "./pages/ChatPage";
import ChatsListPage from "./pages/ChatsListPage";
import AnnouncementsPage from "./pages/AnnouncementsPage";
import MentorDashboard from "./pages/MentorDashboard";
import Home from "./pages/Home";
import EditProfilePage from "./pages/EditProfilePage";
import TopBar from "./components/TopBar";
import Footer from "./components/Footer";

function App() {
  const [user, loading] = useAuthState(auth);

  // Prevent rendering routes while Firebase auth is initializing to avoid
  // a flash of the login page on refresh. Show an empty fullscreen loader.
  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* small blank loader; replace with spinner if desired */}
      </div>
    );
  }

  return (
    <BrowserRouter>
      <div className="flex flex-col min-h-screen">
        <TopBar />
        <main className="flex-grow">
          <Routes>
            <Route path="/" element={user ? <Navigate to="/chats" /> : <Home />} />
            <Route path="/login" element={user ? <Navigate to="/chats" /> : <LoginPage />} />
            <Route path="/register" element={user ? <Navigate to="/chats" /> : <RegisterPage />} />
            <Route path="/chats" element={user ? <ChatsListPage /> : <Navigate to="/login" />} />
            <Route path="/chat/:id" element={user ? <ChatPage /> : <Navigate to="/login" />} />
            <Route path="/announcements" element={user ? <AnnouncementsPage /> : <Navigate to="/login" />} />
            <Route path="/mentor-dashboard" element={user ? <MentorDashboard /> : <Navigate to="/login" />} />
            <Route path="/edit-profile" element={user ? <EditProfilePage /> : <Navigate to="/login" />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}

export default App;