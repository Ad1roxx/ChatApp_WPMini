import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

export default function LoginPage() {
  const nav = useNavigate();
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    const email = e.target.email.value;
    const password = e.target.password.value;

    try {
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      const userDoc = await getDoc(doc(db, "users", user.uid));
      if (userDoc.exists()) {
        const userData = userDoc.data();
        if (userData.role === "mentor") {
          nav("/mentor/dashboard");
        } else {
          nav("/chats");
        }
      } else {
        // Default to student if no role found, though this shouldn't happen in normal flow
        nav("/chats"); 
      }
    } catch (err) {
      if (err.code === "auth/user-not-found") {
        // For simplicity, we're not creating a user here anymore.
        // The user should be created through the register page.
        setError("No user found with this email. Please register.");
      } else {
        setError(err.message);
      }
    }
  };

  return (
    <div className="login-page">
      <div className="blue-box">
        <div className="login-card">
          <h2 className="card-title">Welcome back</h2>
          <p className="subtitle">Sign in to continue</p>

          <form onSubmit={onSubmit} className="form">
            <label className="field">
              <span>Email</span>
              <input type="email" name="email" placeholder="you@example.com" required />
            </label>

            <label className="field">
              <span>Password</span>
              <div className="pwd-wrapper">
                <input
                  type={showPwd ? "text" : "password"}
                  name="password"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  className="toggle-btn"
                  onClick={() => setShowPwd(!showPwd)}
                >
                  {showPwd ? "Hide" : "Show"}
                </button>
              </div>
            </label>

            {error && <p className="error-text">{error}</p>}

            <button className="btn" type="submit">
              Login
            </button>
          </form>

          <p className="footer-text">
            New here?{" "}
            <Link to="/register" className="link">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
