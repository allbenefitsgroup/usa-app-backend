import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

if (process.env.FIREBASE_PRIVATE_KEY) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FUNCTIONS_EMULATOR || process.env.K_SERVICE) {
  initializeApp();
} else {
  throw new Error(
    "Firebase Admin SDK credentials are missing. Set FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL + FIREBASE_PROJECT_ID, or GOOGLE_APPLICATION_CREDENTIALS."
  );
}

export const auth = getAuth();
export const db = getFirestore();
