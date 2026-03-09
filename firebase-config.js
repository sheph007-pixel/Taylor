// ============================================================
// Firebase Configuration
// ============================================================
// HOW TO SET UP (one time, 2 minutes):
// 1. Go to https://console.firebase.google.com
// 2. Click "Create a project" (any name, e.g. "route-runner")
// 3. Skip Google Analytics when asked
// 4. Click "Build" > "Realtime Database" in the left menu
// 5. Click "Create Database" > choose any location > Start in TEST MODE
// 6. Go to Project Settings (gear icon top-left) > scroll down to "Your apps"
// 7. Click the web icon (</>) to add a web app
// 8. Copy the firebaseConfig values below
// ============================================================

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
