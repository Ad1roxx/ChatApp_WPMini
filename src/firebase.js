
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAK_1iJ8zu92LroQYP48pGS1ROfADY7mH0",
  authDomain: "mentor-connectchatapp.firebaseapp.com",
  projectId: "mentor-connectchatapp",
  storageBucket: "mentor-connectchatapp.firebasestorage.app",
  messagingSenderId: "415994108937",
  appId: "1:415994108937:web:a0d65880fad5c831ccecd8",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
