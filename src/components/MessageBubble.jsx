import React from "react";

export default function MessageBubble({ children, mine, time }) {
  return (
    <div className={`bubble ${mine ? "mine" : "theirs"}`}>
        {children}
        <div className="meta">{time}</div>
    </div>
  );
}
