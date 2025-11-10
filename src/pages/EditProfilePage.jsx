import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { doc, getDoc, updateDoc, setDoc, enableNetwork, disableNetwork, serverTimestamp, arrayUnion } from "firebase/firestore";
import { db, auth, storage } from "../firebase";
import { updateProfile } from "firebase/auth";
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import Toast from "../components/Toast";

export default function EditProfilePage() {
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [showToast, setShowToast] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [records, setRecords] = useState([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const fetchUserData = async () => {
      if (!auth.currentUser) {
        nav('/login');
        return;
      }

      // Set initial values from auth object
      if (auth.currentUser.displayName) {
        setDisplayName(auth.currentUser.displayName);
      }

      try {
        // Try to enable network if it was disabled
        await enableNetwork(db);
        
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        if (userDoc.exists()) {
          const userData = userDoc.data();
          setDisplayName(userData.displayName || auth.currentUser.displayName || "");
          setBio(userData.bio || "Let's Connect!");
          setRecords(userData.records || []);
        } else {
          // If document doesn't exist, create it with default values using setDoc (merge-safe)
          const userRef = doc(db, "users", auth.currentUser.uid);
          const defaultData = {
            uid: auth.currentUser.uid,
            displayName: auth.currentUser.displayName || "",
            email: auth.currentUser.email,
            bio: "Let's Connect!"
          };
          await setDoc(userRef, defaultData, { merge: true });
          setDisplayName(defaultData.displayName);
          setBio(defaultData.bio);
        }
      } catch (err) {
        console.error("Error fetching user data:", err);
        // If we're offline, use cached data from auth object
        setError("You appear to be offline. Some data may not be up to date.");
      }
    };

    fetchUserData();
    
    // Cleanup function to ensure network is enabled when component unmounts
    return () => {
      enableNetwork(db).catch(console.error);
    };
  }, [nav]);

  const handleSave = async () => {
    if (!auth.currentUser) {
      nav('/login');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // First update Auth Profile as it's more critical
      await updateProfile(auth.currentUser, {
        displayName: displayName
      });

      // Then update Firestore
      const userRef = doc(db, "users", auth.currentUser.uid);
      // Use setDoc with merge to avoid "No document to update" when the doc is missing
      await setDoc(userRef, {
        displayName,
        bio,
      }, { merge: true });

      // Show success toast
      setShowToast(true);

      // Navigate to home and refresh the page after the toast so TopBar shows updated data
      setTimeout(() => {
        try {
          nav("/");
        } catch (e) {
          console.warn("Navigation failed:", e);
        }
        // small delay to allow route change then force a full reload
        setTimeout(() => {
          window.location.reload();
        }, 150);
      }, 1500);
    } catch (error) {
      console.error("Error updating profile:", error);
      setError("Failed to update profile. Please check your internet connection and try again.");
      // Keep the changes on the form so user can retry
      setIsLoading(false);
      return;
    }
    
    setIsLoading(false);
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!auth.currentUser) return setError('Not authenticated');

    setUploading(true);
    setError(null);
    try {
      const uid = auth.currentUser.uid;
      const fileId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.floor(Math.random()*100000)}`;
      const path = `users/${uid}/records/${fileId}_${file.name}`;
      const sRef = storageRef(storage, path);
      const uploadTask = uploadBytesResumable(sRef, file);

      await new Promise((resolve, reject) => {
        uploadTask.on('state_changed', () => {}, (err) => reject(err), () => resolve());
      });

      const downloadURL = await getDownloadURL(sRef);

      const entry = {
        id: fileId,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        storagePath: path,
        downloadURL,
        createdAt: serverTimestamp()
      };

      const userRef = doc(db, 'users', uid);
      // append to records array
      await updateDoc(userRef, { records: arrayUnion(entry) });

      // update local state for immediate UI feedback
      setRecords((r) => [...r, entry]);
    } catch (err) {
      console.error('Upload failed:', err);
      setError('Failed to upload file');
    }
    setUploading(false);
    // reset file input
    e.target.value = null;
  };

  return (
    <div className="edit-profile-page">
      <h1>Edit Profile</h1>
      <div className="form-group">
        <label htmlFor="displayName">Display Name</label>
        <input
          type="text"
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label htmlFor="bio">Bio</label>
        <textarea
          id="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        ></textarea>
      </div>
      <button 
        className="btn" 
        onClick={handleSave} 
        disabled={isLoading}
      >
        {isLoading ? "Saving..." : "Save"}
      </button>
      
      {error && (
        <div className="error-message">
          {error}
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        <label style={{ display: 'block', marginBottom: 8 }}>Upload Records / Achievements (PDF, image, doc)</label>
        <input type="file" onChange={handleFileSelect} />
        {uploading && <div style={{ marginTop: 8, color: '#6b7280' }}>Uploading...</div>}
        <div style={{ marginTop: 12 }}>
          <h4 style={{ margin: '8px 0' }}>Uploaded Records</h4>
          {records.length === 0 && <div style={{ color: '#6b7280' }}>No records yet.</div>}
          {records.map((r) => (
            <div key={r.id || r.storagePath} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{r.filename}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>{r.mimeType} {r.size ? `• ${Math.round(r.size/1024)} KB` : ''}</div>
              </div>
              {r.downloadURL ? (
                <a href={r.downloadURL} target="_blank" rel="noreferrer" className="btn small">Open</a>
              ) : (
                <div style={{ color: '#9ca3af' }}>Processing...</div>
              )}
            </div>
          ))}
        </div>
      </div>
      
      {showToast && (
        <Toast
          message="Changes Saved Successfully"
          type="success"
          onClose={() => setShowToast(false)}
        />
      )}
    </div>
  );
}
