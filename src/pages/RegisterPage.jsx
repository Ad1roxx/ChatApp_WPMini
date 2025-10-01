import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

export default function RegisterPage() {
  const nav = useNavigate();
  const [showPwd, setShowPwd] = useState(false);
  const [role, setRole] = useState("student");

  const onSubmit = (e) => {
    e.preventDefault();
    if (role === "mentor") {
      nav("/mentor/chats");
    } else {
      nav("/chats");
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
              <input type="text" placeholder="Your name" required />
            </label>

            <label className="field">
              <span>Email</span>
              <input type="email" placeholder="you@example.com" required />
            </label>

            <label className="field">
              <span>Password</span>
              <div className="pwd-wrapper">
                <input
                  type={showPwd ? "text" : "password"}
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
