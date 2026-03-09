// ============================================================
// Firebase Configuration
// ============================================================
// HOW TO SET UP (one time, 2 minutes):
// 1. Go to https://console.firebase.google.com
// 2. Click "Create a project" (any name, e.g. "route-runner")
// 3. Skip Google Analytics when asked
// 4. Click "Build" > "Firestore Database" > Create Database > Start in TEST MODE
// 5. Go to Project Settings (gear icon top-left) > scroll down to "Your apps"
// 6. Click the web icon (</>) to add a web app
// 7. Copy the firebaseConfig values below
// ============================================================

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
