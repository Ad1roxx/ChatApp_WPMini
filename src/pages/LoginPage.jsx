import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

export default function LoginPage() {
  const nav = useNavigate();
  const [showPwd, setShowPwd] = useState(false);

  const onSubmit = (e) => {
    e.preventDefault();
    nav("/chats");
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
              <input type="email" placeholder="you@example.com" required />
            </label>

            <label className="field">
              <span>Password</span>
              <div className="pwd-wrapper">
                <input
                  type={showPwd ? "text" : "password"}
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
