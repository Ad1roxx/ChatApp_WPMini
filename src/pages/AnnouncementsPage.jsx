import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import useStore from "../announcements";

export default function AnnouncementsPage() {
  const nav = useNavigate();
  const { announcements, addAnnouncement } = useStore();
  const [newAnnouncement, setNewAnnouncement] = useState("");

  const handleSend = () => {
    if (newAnnouncement.trim()) {
      addAnnouncement({
        id: announcements.length + 1,
        text: newAnnouncement.trim(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      setNewAnnouncement("");
    }
  };

  return (
    <div className="chat-page announcements-page">
      <div className="chat-header">
        <button onClick={() => nav("/mentor/chats")} className="back-btn icon-btn">
          &larr;
        </button>
        <div className="peer">
          <div className="title">Announcements</div>
        </div>
      </div>

      <div className="messages">
        {announcements.map((ann) => (
          <div key={ann.id} className="bubble mine">
            {ann.text}
            <div className="meta">{ann.time}</div>
          </div>
        ))}
      </div>

      <div className="composer">
        <input
          type="text"
          value={newAnnouncement}
          onChange={(e) => setNewAnnouncement(e.target.value)}
          placeholder="Type an announcement..."
          onKeyPress={(e) => e.key === "Enter" && handleSend()}
        />
        <button onClick={handleSend} className="send icon-btn">
          &#10148;
        </button>
      </div>
    </div>
  );
}
