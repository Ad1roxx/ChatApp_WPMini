import React from "react";
import { Link } from "react-router-dom";

export default function MentorDashboard() {
  return (
    <div className="mentor-dashboard">
      <h2>Mentor Dashboard</h2>
      <div className="dashboard-actions">
        <Link to="/mentor/users" className="btn">
          Find a Student
        </Link>
        <Link to="/chats" className="btn">
          My Chats
        </Link>
      </div>
    </div>
  );
}
