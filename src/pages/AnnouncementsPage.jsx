import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function AnnouncementsPage() {
  const nav = useNavigate();
  const [announcements, setAnnouncements] = useState([]);
  const [newAnnouncement, setNewAnnouncement] = useState("");

  useEffect(() => {
    fetch("http://localhost:3001/api/announcements")
      .then((res) => res.json())
      .then((data) => setAnnouncements(data));
  }, []);

  const handleSend = () => {
    if (newAnnouncement.trim()) {
      const announcement = {
        text: newAnnouncement.trim(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      fetch("http://localhost:3001/api/announcements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(announcement),
      })
        .then((res) => res.json())
        .then((newAnn) => {
          setAnnouncements([...announcements, newAnn]);
          setNewAnnouncement("");
        });
    }
  };

  return (
    <div className="chat-page announcements-page">
      <div className="chat-header">
        <button onClick={() => nav("/")} className="back-btn icon-btn">
          &larr;
        </button>
        <div className="peer">
          <div className="title">Announcements</div>
        </div>
      </div>

      <div className="messages">
        {announcements.map((ann, index) => (
          <div key={index} className="bubble mine">
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
