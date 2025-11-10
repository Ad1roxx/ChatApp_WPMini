import React, { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db, auth } from "../firebase";

export default function NewChatModal({ open, onClose, onCreateChat }) {
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    const fetchUsers = async () => {
      setLoading(true);
      try {
        const q = query(collection(db, "users"));
        const snap = await getDocs(q);
        const list = [];
        const uniqueUsers = new Map(); // Track unique users by displayName
        snap.forEach((d) => {
          const data = d.data();
          const displayName = data.displayName || "Anonymous";
          // Only keep the first occurrence of each displayName
          if (!uniqueUsers.has(displayName)) {
            uniqueUsers.set(displayName, {
              uid: d.id,
              displayName,
              role: data.role || "student"
            });
          }
        });
        if (mounted) setUsers(Array.from(uniqueUsers.values()));
      } catch (err) {
        console.error("Failed to load users for NewChatModal:", err);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    fetchUsers();
    return () => { mounted = false; };
  }, [open]);

  const matches = (u) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (u.displayName || "").toLowerCase().includes(q) || (u.role || "").toLowerCase().includes(q);
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
          <h3 style={{margin:0}}>Start New Chat</h3>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <input
          placeholder="Search users or roles"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{width:'100%', padding:8, marginBottom:8, borderRadius:8, border:'1px solid #ccc'}}
        />

        <div style={{maxHeight:280, overflowY:'auto'}}>
          {loading && <div>Loading users…</div>}
          {!loading && users.filter(matches).map((u) => (
            <div key={u.uid} style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 4px', borderBottom:'1px solid #f0f0f0'}}>
              <div style={{display:'flex', gap:8, alignItems:'center'}}>
                <div style={{width:36, height:36, borderRadius:18, background:'#3f51b5', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700}}>{(u.displayName||'U').charAt(0)}</div>
                <div>
                  <div style={{fontWeight:600}}>{u.displayName}</div>
                  <div style={{fontSize:12, color:'#666'}}>{u.role}</div>
                </div>
              </div>
              <div>
                <button className="btn small" onClick={() => onCreateChat(u.uid, u.displayName)}>
                  Chat
                </button>
              </div>
            </div>
          ))}
          {!loading && users.filter(matches).length === 0 && (
            <div style={{padding:12, color:'#666'}}>No users found</div>
          )}
        </div>
      </div>
    </div>
  );
}
