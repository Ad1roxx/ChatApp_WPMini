/**
 * LoginPage - Google Sign-in
 * 
 * This page shows a "Sign in with Google" button.
 * When clicked:
 * 1. Firebase opens Google's login popup
 * 2. User selects their Google account
 * 3. Firebase returns user info (email, name, photo)
 * 4. AuthContext saves user to our MongoDB
 * 5. User is redirected to /users
 * 
 * Why use Google Sign-in?
 * - No need to build password reset, email verification, etc.
 * - Users don't need to remember another password
 * - Google handles security (2FA, suspicious login detection)
 */

import { useState } from "react";
import { signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "../firebase";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  /**
   * Handle Google Sign-in
   * 
   * signInWithPopup opens a popup window for Google login.
   * After successful login, onAuthStateChanged in AuthContext
   * will automatically register the user in our database.
   */
  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError("");
    
    try {
      await signInWithPopup(auth, googleProvider);
      // No need to navigate - App.jsx will redirect when user state changes
    } catch (err) {
      console.error("Google sign-in error:", err);
      
      // User-friendly error messages
      if (err.code === "auth/popup-closed-by-user") {
        setError("Sign-in cancelled. Please try again.");
      } else if (err.code === "auth/popup-blocked") {
        setError("Popup was blocked. Please allow popups for this site.");
      } else {
        setError("Failed to sign in. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Background box */}
      <div className="blue-box">
        <div className="login-card">
          {/* Header */}
          <h1 className="card-title">Welcome to Chat</h1>
          <p className="subtitle">Sign in to start messaging</p>

          {/* Google Sign-in Button */}
          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="google-btn"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              width: '100%',
              padding: '12px 24px',
              marginTop: '24px',
              fontSize: '16px',
              fontWeight: '500',
              color: '#333',
              backgroundColor: '#fff',
              border: '1px solid #ddd',
              borderRadius: '8px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            {/* Google Logo SVG */}
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            {loading ? 'Signing in...' : 'Sign in with Google'}
          </button>

          {/* Error message */}
          {error && (
            <p style={{
              marginTop: '16px',
              padding: '12px',
              backgroundColor: '#fef2f2',
              color: '#dc2626',
              borderRadius: '8px',
              fontSize: '14px',
              textAlign: 'center'
            }}>
              {error}
            </p>
          )}

          {/* Info text */}
          <p style={{
            marginTop: '24px',
            fontSize: '13px',
            color: '#666',
            textAlign: 'center'
          }}>
            By signing in, you agree to our Terms of Service
          </p>
        </div>
      </div>
    </div>
  );
}
