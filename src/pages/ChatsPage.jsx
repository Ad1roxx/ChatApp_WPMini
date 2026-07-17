// src/pages/ChatsPage.js
import React, { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";

const SAMPLE_CHATS = [
  { id: "1", name: "Alice", avatar: "A", lastMessage: "See you soon!", time: "09:05" },
  { id: "2", name: "Bob", avatar: "B", lastMessage: "Hey, what’s up?", time: "08:41" },
  { id: "3", name: "Charlie", avatar: "C", lastMessage: "Got it, thanks!", time: "23:07" },
];

export default function ChatsPage() {
  const [q, setQ] = useState("");
  const nav = useNavigate();

  const filtered = useMemo(() => {
    if (!q.trim()) return SAMPLE_CHATS;
    return SAMPLE_CHATS.filter((c) =>
      c.name.toLowerCase().includes(q.toLowerCase())
    );
  }, [q]);

  return (
    <div className="chats-page">
      {/* Header search bar */}
      <div className="chats-header">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search or start new chat"
        />
      </div>

      {/* Chat list */}
      <div className="chat-list">
        {filtered.map((c) => (
          <Link key={c.id} to={`/chat/${c.id}`} className="chat-item">
            <Avatar label={c.avatar} />
            <div className="chat-meta">
              <div className="row">
                <span className="name">{c.name}</span>
                <span className="time">{c.time}</span>
              </div>
              <span className="preview">{c.lastMessage}</span>
            </div>
          </Link>
        ))}
      </div>

      {/* Floating Action Button */}
      <button className="fab" onClick={() => nav("/chat/new")}>
        ＋
      </button>
    </div>
  );
}
