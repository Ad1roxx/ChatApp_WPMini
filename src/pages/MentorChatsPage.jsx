import React from "react";
import { useNavigate } from "react-router-dom";
import useStore from "../announcements";

const students = [
  { id: 1, name: "Alice", lastMessage: "See you tomorrow!", time: "10:45 AM" },
  { id: 2, name: "Bob", lastMessage: "Thanks for the help.", time: "Yesterday, 4:30 PM" },
  { id: 3, name: "Charlie", lastMessage: "Got it, thanks.", time: "Yesterday, 11:15 AM" },
];

export default function MentorChatsPage() {
  const nav = useNavigate();
  const { announcements } = useStore();
  const lastAnnouncement = announcements[announcements.length - 1];

  const handleStudentChat = (student) => {
    nav(`/chat/${student.id}`);
  };

  return (
    <div className="mentor-chats-page">
      <div className="announcements-section" onClick={() => nav("/mentor/announcements")}>
        <div className="announcements-bar">
          <div className="announcement-info">
            <span className="announcement-icon">📢</span>
            <p className="announcement-text">Announcements: {lastAnnouncement.text}</p>
          </div>
          <span className="announcement-time">{lastAnnouncement.time}</span>
        </div>
      </div>

      <div className="group-chat-section" onClick={() => nav('/chat/group')}>
        <div className="group-chat-avatar">G</div>
        <div className="group-chat-info">
          <p className="group-chat-name">Group Chat</p>
          <div className="group-chat-preview">
            <p>Mentor: Remember the deadline...</p>
            <span className="time">12:30 PM</span>
          </div>
        </div>
      </div>

      <div className="student-list-header">Students</div>

      <div className="student-list">
        {students.map((student) => (
          <div key={student.id} className="student-item" onClick={() => handleStudentChat(student)}>
            <div className="student-avatar">{student.name.charAt(0)}</div>
            <div className="student-info">
              <p className="student-name">{student.name}</p>
              <div className="student-preview-line">
                <p className="student-preview">{student.lastMessage}</p>
                <p className="student-time">{student.time}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
