import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

export default function RegisterPage() {
  const nav = useNavigate();
  const [showPwd, setShowPwd] = useState(false);
  const [role, setRole] = useState("student");
  const [error, setError] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    const username = e.target.username.value;
    const email = e.target.email.value;
    const password = e.target.password.value;

    try {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(user, { displayName: username });

      await setDoc(doc(db, "users", user.uid), {
        uid: user.uid,
        displayName: username,
        email: user.email,
        role: role,
        bio: "Let's Connect!"
      });

      if (role === "mentor") {
        nav("/mentor/dashboard");
      } else {
        nav("/chats");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="register-page">
      <div className="blue-box">
        <div className="login-card">
          <h2 className="card-title">Create account</h2>
          <p className="subtitle">Join the mentorship community</p>

          <form onSubmit={onSubmit} className="form">
            <label className="field">
              <span>Username</span>
              <input type="text" name="username" placeholder="Your name" required />
            </label>

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
                  placeholder="Create a password"
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

            <label className="field">
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="student">Student</option>
                <option value="mentor">Mentor</option>
              </select>
            </label>

            {error && <p className="error-text">{error}</p>}

            <button className="btn" type="submit">
              Register
            </button>
          </form>

          <p className="footer-text">
            Already have an account?{" "}
            <Link to="/" className="link">
              Login
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
