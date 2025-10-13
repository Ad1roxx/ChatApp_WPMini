import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthState } from "react-firebase-hooks/auth";
import { auth } from "./firebase";

import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ChatPage from "./pages/ChatPage";
import AnnouncementsPage from "./pages/AnnouncementsPage";
import MentorDashboard from "./pages/MentorDashboard";
import Home from "./pages/Home";
import TopBar from "./components/TopBar";
import Footer from "./components/Footer";

function App() {
  const [user] = useAuthState(auth);

  return (
    <div className="flex flex-col min-h-screen">
      <BrowserRouter>
        <TopBar />
        <main className="flex-grow">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/chats"
              element={user ? <ChatPage /> : <Navigate to="/login" />}
            />
            {/* Temporarily remove auth check for announcements page */}
            <Route
              path="/announcements"
              element={<AnnouncementsPage />}
            />
            <Route
              path="/mentor-dashboard"
              element={user ? <MentorDashboard /> : <Navigate to="/login" />}
            />
          </Routes>
        </main>
        <Footer />
      </BrowserRouter>
    </div>
  );
}

export default App;