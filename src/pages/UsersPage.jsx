import React, { useState, useEffect } from "react";
import { collection, query, where, getDocs, setDoc, doc, getDoc } from "firebase/firestore";
import { db, auth } from "../firebase";
import { useNavigate } from "react-router-dom";
import Avatar from "../components/Avatar";

export default function UsersPage() {
  const [students, setStudents] = useState([]);
  const nav = useNavigate();

  useEffect(() => {
    const fetchStudents = async () => {
      const q = query(collection(db, "users"), where("role", "==", "student"));
      const querySnapshot = await getDocs(q);
      const studentData = [];
      querySnapshot.forEach((doc) => {
        studentData.push(doc.data());
      });
      setStudents(studentData);
    };

    fetchStudents();
  }, []);

  const startChat = async (student) => {
    const { uid, displayName } = auth.currentUser;
    const chatId = [uid, student.uid].sort().join("-");

    const chatDocRef = doc(db, "chats", chatId);
    const chatDoc = await getDoc(chatDocRef);

    if (!chatDoc.exists()) {
        await setDoc(chatDocRef, {
            users: [uid, student.uid],
            userNames: [displayName, student.displayName]
        });
    }

    nav(`/chat/${chatId}`);
  };

  return (
    <div className="users-page">
      <h2>Find a Student</h2>
      <div className="user-list">
        {students.map((student) => (
          <div key={student.uid} className="user-card">
            <Avatar label={student.displayName[0]} />
            <div className="user-info">
              <p>{student.displayName}</p>
              <p>{student.email}</p>
            </div>
            <button className="btn" onClick={() => startChat(student)}>
              Chat
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
