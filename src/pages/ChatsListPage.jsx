import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { db, auth } from "../firebase";

export default function ChatsListPage() {
  const nav = useNavigate();
  const [announcements, setAnnouncements] = useState([]);
  const lastAnnouncement = announcements.length > 0 ? announcements[announcements.length - 1] : null;
  const [chats, setChats] = useState([]);
  const [userRole, setUserRole] = useState(null);

  useEffect(() => {
    fetch("http://localhost:3001/api/announcements")
      .then((res) => res.json())
      .then((data) => setAnnouncements(data));

    const fetchUserRole = async () => {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      if (userDoc.exists()) {
        setUserRole(userDoc.data().role);
      }
    };

    const fetchChats = async () => {
      const q = query(collection(db, "chats"), where("users", "array-contains", auth.currentUser.uid));
      const querySnapshot = await getDocs(q);
      const chatData = [];
      querySnapshot.forEach((doc) => {
        chatData.push({ id: doc.id, ...doc.data() });
      });
      setChats(chatData);
    };

    fetchUserRole();
    fetchChats();
  }, []);

  const handleChatClick = (chatId) => {
    nav(`/chat/${chatId}`);
  };
  
  const getPeerName = (chat) => {
    const { uid } = auth.currentUser;
    const peerIndex = chat.users.findIndex(u => u !== uid);
    return chat.userNames[peerIndex];
  }


  return (
    <div className="mentor-chats-page">
        {userRole === "mentor" && lastAnnouncement && (
            <div className="announcements-section" onClick={() => nav("/mentor/announcements")}>
                <div className="announcements-bar">
                <div className="announcement-info">
                    <span className="announcement-icon">📢</span>
                    <p className="announcement-text">Announcements: {lastAnnouncement.text}</p>
                </div>
                <span className="announcement-time">{lastAnnouncement.time}</span>
                </div>
            </div>
        )}

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

      <div className="student-list-header">Chats</div>

      <div className="student-list">
        {chats.map((chat) => (
          <div key={chat.id} className="student-item" onClick={() => handleChatClick(chat.id)}>
            <div className="student-avatar">{getPeerName(chat).charAt(0)}</div>
            <div className="student-info">
              <p className="student-name">{getPeerName(chat)}</p>
            </div>
          </div>
        ))}
      </div>
      {userRole === 'mentor' && (
        <button className="btn" onClick={() => nav("/mentor/users")}>
          Find a Student
        </button>
      )}
    </div>
  );
}
