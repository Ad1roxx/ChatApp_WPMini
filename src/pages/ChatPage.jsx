import React, { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";
import MessageBubble from "../components/MessageBubble";
import Composer from "../components/Composer";
import DayDivider from "../components/DayDivider";

const SAMPLE_MESSAGES = {
  "1": [
    { id: 1, from: "Alice", text: "Hi there!", mine: false, time: "09:03" },
    { id: 2, from: "Me", text: "Hello!", mine: true, time: "09:04" },
    { id: 3, from: "Alice", text: "See you tomorrow!", mine: false, time: "10:45" },
  ],
  "2": [],
  "3": [],
};

const TypingStatus = () => (
  <div className="typing-status">
    <span>typing</span>
    <div className="dot"></div>
    <div className="dot"></div>
    <div className="dot"></div>
  </div>
);

export default function ChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [messages, setMessages] = useState(SAMPLE_MESSAGES[id] || []);
  const [isTyping, setIsTyping] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    if (isTyping) {
      const timeout = setTimeout(() => setIsTyping(false), 2000);
      return () => clearTimeout(timeout);
    }
  }, [isTyping]);

  const send = (text) => {
    const userMessage = { id: Date.now(), from: "Me", text, mine: true, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    setMessages(prev => [...prev, userMessage]);
  };

  return (
    <div className="chat-page">
      <div className="chat-header">
        <button className="icon-btn" onClick={() => nav(-1)}>
          ←
        </button>
        <Avatar label={"A"} />
        <div className="peer">
          <div className="title">{`User ${id}`}</div>
          <div className="status">
            {isTyping ? <TypingStatus /> : "online"}
          </div>
        </div>
      </div>

      <div ref={listRef} className="messages">
        <DayDivider label="Today" />
        {messages.map((m) => (
          <MessageBubble key={m.id} mine={m.mine} time={m.time}>
            {m.text}
          </MessageBubble>
        ))}
      </div>

      <Composer onSend={send} onTyping={() => setIsTyping(true)} />
    </div>
  );
}
