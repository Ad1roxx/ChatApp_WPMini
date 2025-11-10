
import { initializeApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBuYIpixh6qH88zkfet_xQEFC5qABRFyBI",
  authDomain: "chatcsp-52686610-61cb3.firebaseapp.com",
  projectId: "chatcsp-52686610-61cb3",
  storageBucket: "chatcsp-52686610-61cb3.appspot.com",
  messagingSenderId: "748741354637",
  appId: "1:748741354637:web:aa11b71b1e54f6c763eec4",
  measurementId: "G-T8QTLVGNNE",
  experimentalForceLongPolling: true,
  useFetchStreams: false
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Configure Firestore
const firestoreDb = getFirestore(app);
export const db = firestoreDb;
export const analytics = getAnalytics(app);
export const storage = getStorage(app);

// Initialize auth persistence
setPersistence(auth, browserLocalPersistence)
  .catch((error) => {
    console.error("Auth persistence error:", error);
  });

// Initialize Firestore offline persistence
(async () => {
  try {
    await enableIndexedDbPersistence(firestoreDb, {
      synchronizeTabs: true
    });
    console.log("Offline persistence enabled successfully");
  } catch (err) {
    if (err.code === 'failed-precondition') {
      console.warn('Offline persistence requires a single tab');
    } else if (err.code === 'unimplemented') {
      console.warn('Browser doesn\'t support persistence');
    } else {
      console.error("Persistence error:", err);
    }
  }
})();
