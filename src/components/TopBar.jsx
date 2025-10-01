import React from "react";

export default function TopBar({ dark, setDark }) {
  return (
    <div className="topbar">
      <span className="brand">MentorConnect</span>
      <button className="icon-btn" onClick={() => setDark(!dark)}>
        {dark ? "☀️" : "🌙"}
      </button>
    </div>
  );
}
