import React, { useState, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { doc, onSnapshot, collection, addDoc, serverTimestamp, query, orderBy, getDoc } from 'firebase/firestore';
import { db, auth } from "../firebase";
import Avatar from "../components/Avatar";
import MessageBubble from "../components/MessageBubble";
import Composer from "../components/Composer";
import DayDivider from "../components/DayDivider";

export default function ChatPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [messages, setMessages] = useState([]);
  const [chat, setChat] = useState(null);
  const listRef = useRef(null);
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const send = async (text) => {
    const { uid, displayName } = auth.currentUser;
    await addDoc(collection(db, "chats", id, "messages"), {
      text: text,
      from: displayName,
      createdAt: serverTimestamp(),
      uid
    });
  };

  useEffect(() => {
    const chatDocRef = doc(db, "chats", id);
    const unsubChat = onSnapshot(chatDocRef, (doc) => {
      setChat(doc.data());
    });

    const q = query(collection(db, "chats", id, "messages"), orderBy("createdAt"));
    const unsubMessages = onSnapshot(q, (querySnapshot) => {
      const newMessages = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        newMessages.push({
          id: doc.id,
          ...data,
          mine: data.uid === auth.currentUser.uid
        });
      });
      setMessages(newMessages);
    });

    return () => {
      unsubChat();
      unsubMessages();
    };
  }, [id]);

  const getPeerName = () => {
    if (chat) {
      const { uid } = auth.currentUser;
      const peerIndex = chat.users.findIndex(u => u !== uid);
      return chat.userNames[peerIndex];
    }
    return "";
  }

  const peerName = getPeerName();

  return (
    <div className="chat-page">
      <div className="chat-header">
        <button className="icon-btn" onClick={() => nav(-1)}>
          ←
        </button>
        <Avatar label={peerName ? peerName[0] : "?"} />
        <div className="peer">
          <div className="title">{peerName}</div>
          <div className="status">
            {"online"}
          </div>
        </div>
      </div>

      <div ref={listRef} className="messages">
        <DayDivider label="Today" />
        {messages.map((m) => (
          <MessageBubble key={m.id} mine={m.mine} time={m.createdAt?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}>
            {m.text}
          </MessageBubble>
        ))}
      </div>

      <Composer onSend={send} onTyping={() => {}} />
    </div>
  );
}
