import React, { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import TopBar from "./components/TopBar";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ChatPage from "./pages/ChatPage";
import MentorChatsPage from "./pages/MentorChatsPage";
import AnnouncementsPage from "./pages/AnnouncementsPage";
import "./App.css";

export default function App() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    if (dark) {
      document.body.classList.add("dark");
    } else {
      document.body.classList.remove("dark");
    }
  }, [dark]);

  return (
    <div className="app">
      <TopBar dark={dark} setDark={setDark} />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/mentor/chats" element={<MentorChatsPage />} />
          <Route path="/chat/group" element={<ChatPage />} />
          <Route path="/mentor/announcements" element={<AnnouncementsPage />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}
