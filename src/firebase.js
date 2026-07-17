/**
 * Firebase Configuration - AUTHENTICATION ONLY
 * 
 * We're using Firebase ONLY for Google Sign-in.
 * Everything else (messages, users) is handled by our own server + MongoDB.
 * 
 * Why Firebase Auth?
 * - Google handles security, password hashing, OAuth flows
 * - We get a unique user ID (uid) and email without building auth ourselves
 * - The "Sign in with Google" button just works
 */

import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from "firebase/auth";

// Your Firebase project config (from Firebase Console > Project Settings)
const firebaseConfig = {
  apiKey: "AIzaSyBuYIpixh6qH88zkfet_xQEFC5qABRFyBI",
  authDomain: "chatcsp-52686610-61cb3.firebaseapp.com",
  projectId: "chatcsp-52686610-61cb3",
  storageBucket: "chatcsp-52686610-61cb3.appspot.com",
  messagingSenderId: "748741354637",
  appId: "1:748741354637:web:aa11b71b1e54f6c763eec4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Get the Auth instance - this is what we use for login/logout
export const auth = getAuth(app);

// Google Auth Provider - needed for "Sign in with Google" button
export const googleProvider = new GoogleAuthProvider();

// Keep user logged in even after browser closes (stored in localStorage)
// Without this, users would need to login every time they open the app
setPersistence(auth, browserLocalPersistence)
  .catch((error) => {
    console.error("Auth persistence error:", error);
  });
