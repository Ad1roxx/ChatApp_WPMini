import { initializeApp } from "firebase/app";

// TODO: Replace with your own Firebase project configuration
const firebaseConfig = {
  apiKey: "<your-api-key>",
  authDomain: "<your-auth-domain>",
  projectId: "<your-project-id>",
  storageBucket: "<your-storage-bucket>",
  messagingSenderId: "<your-messaging-sender-id>",
  appId: "<your-app-id>",
};

export const app = initializeApp(firebaseConfig);
