import React, { useState, useEffect, useRef } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, db } from "../firebase";
import { doc, onSnapshot } from "firebase/firestore";
import { Link, useNavigate } from "react-router-dom";
import Avatar from "./Avatar";

export default function TopBar() {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState({ displayName: "", bio: "Let's Connect!" });
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    // Only listen for auth changes here and store the user in state.
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      if (!user) {
        // reset profile when signed out
        setUserProfile({ displayName: "", bio: "Let's Connect!" });
      }
    });

    return () => unsubscribe();
  }, []);

  // Separate effect: when `user` is present, attach a single onSnapshot listener
  // and clean it up when `user` changes or component unmounts. This prevents
  // creating multiple snapshot listeners inadvertently (which can cause
  // Firestore errors like Target ID already exists).
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, "users", user.uid);
    const unsubscribeUserData = onSnapshot(userRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setUserProfile({
          displayName: data.displayName || user.displayName || user.email,
          bio: data.bio || "Let's Connect!"
        });
      } else {
        setUserProfile({
          displayName: user.displayName || user.email,
          bio: "Let's Connect!"
        });
      }
    }, (err) => {
      console.error('User snapshot error:', err);
    });

    return () => unsubscribeUserData();
  }, [user]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      navigate('/login');
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  return (
    <div className="topbar">
      <Link to="/" className="brand">MentorConnect</Link>
      <div className="topbar-actions">
        {user && (
          <div className="profile-section" ref={dropdownRef}>
            <div 
              className="user-info" 
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              style={{ cursor: 'pointer' }}
            >
              <Avatar label={userProfile.displayName[0] || "?"} />
              <div className="user-text">
                <span className="display-name">{userProfile.displayName}</span>
                <span className={`user-bio ${isHovered || isDropdownOpen ? 'visible' : ''}`}>
                  {userProfile.bio}
                </span>
              </div>
              <span className={`dropdown-arrow ${isDropdownOpen ? 'open' : ''}`}>▼</span>
            </div>
            {isDropdownOpen && (
              <div className="profile-dropdown">
                <Link to="/edit-profile" className="dropdown-item" onClick={() => setIsDropdownOpen(false)}>
                  Edit Profile
                </Link>
                <button className="dropdown-item logout-item" onClick={handleLogout}>
                  Logout
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
