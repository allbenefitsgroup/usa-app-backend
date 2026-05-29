import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY;
const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const hasExplicitServiceAccount = !!firebasePrivateKey && !!firebaseClientEmail;
const hasApplicationCredentialsFile = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
const isGoogleManagedRuntime = !!process.env.FUNCTIONS_EMULATOR || !!process.env.K_SERVICE;

export const isFirebaseAdminConfigured =
  hasExplicitServiceAccount || hasApplicationCredentialsFile || isGoogleManagedRuntime;

// Avoid duplicate initialization (common in hot-reload / test environments)
if (getApps().length === 0) {
  if (hasExplicitServiceAccount) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
        clientEmail: firebaseClientEmail,
        privateKey: firebasePrivateKey.replace(/\\n/g, "\n"),
      }),
    });
  } else {
    // In Firebase Functions / Cloud Run this picks up the default service account automatically
    initializeApp();
  }
}

export const auth = getAuth();
export const db = getFirestore();

export function assertFirebaseAdminConfigured() {
  if (!isFirebaseAdminConfigured) {
    throw new Error(
      "Firebase Admin credentials are not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Railway.",
    );
  }
}
