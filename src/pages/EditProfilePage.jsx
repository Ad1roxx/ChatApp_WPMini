import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db, auth } from "../firebase";

export default function EditProfilePage() {
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");

  useEffect(() => {
    const fetchUserData = async () => {
      const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
      if (userDoc.exists()) {
        const userData = userDoc.data();
        setDisplayName(userData.displayName || "");
        setBio(userData.bio || "");
      }
    };

    fetchUserData();
  }, []);

  const handleSave = async () => {
    const userRef = doc(db, "users", auth.currentUser.uid);
    await updateDoc(userRef, {
      displayName,
      bio,
    });
    nav("/");
  };

  return (
    <div className="edit-profile-page">
      <h1>Edit Profile</h1>
      <div className="form-group">
        <label htmlFor="displayName">Display Name</label>
        <input
          type="text"
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label htmlFor="bio">Bio</label>
        <textarea
          id="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        ></textarea>
      </div>
      <button className="btn" onClick={handleSave}>
        Save
      </button>
    </div>
  );
}
