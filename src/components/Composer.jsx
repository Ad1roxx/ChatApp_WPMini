import React, { useState } from "react";

export default function Composer({ onSend, onTyping }) {
  const [text, setText] = useState("");

    const handleSubmit = (e) => {
        e.preventDefault();
            if (!text.trim()) return;
                onSend(text);
                    setText("");
                      };

                        const handleChange = (e) => {
                            setText(e.target.value);
                                if (onTyping) {
                                      onTyping();
                                          }
                                            };

                                              return (
                                                  <form className="composer" onSubmit={handleSubmit}>
                                                        <input
                                                                value={text}
                                                                        onChange={handleChange}
                                                                                placeholder="Type a message"
                                                                                      />
                                                                                            <button type="submit" className="send">
                                                                                                    ➤
                                                                                                          </button>
                                                                                                              </form>
                                                                                                                );
                                                                                                                }
                                                                                                                