import React, { useState, useEffect } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "../firebase";
import { Link } from "react-router-dom";

export default function TopBar() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
    });

    return unsubscribe;
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  return (
    <div className="topbar">
      <Link to="/" className="brand">MentorConnect</Link>
      <div className="topbar-actions">
        {user && (
          <>
            <Link to="/edit-profile" className="btn">
                Edit Profile
            </Link>
            <button className="btn" onClick={handleLogout}>
              Logout
            </button>
          </>
        )}
      </div>
    </div>
  );
}
