import React, { useState } from "react";

export default function Composer({ onSend, onTyping }) {
  const [text, setText] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    // notify parent that composing ended for this message
    if (onTyping) onTyping(false);
    setText("");
  };

  const handleChange = (e) => {
    setText(e.target.value);
    if (onTyping) {
      onTyping(e.target.value.length > 0);
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <input
        value={text}
        onChange={handleChange}
        onKeyDown={() => { if (onTyping) onTyping(true); }}
        onBlur={() => { if (onTyping) onTyping(false); }}
        placeholder="Type a message"
      />
      <button type="submit" className="send">
        ➤
      </button>
    </form>
  );
                                                                                                                }
                                                                                                                