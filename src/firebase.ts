import { initializeApp } from 'firebase/app';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  // ← Colle ici ton config depuis Firebase Console → Project Settings
};

const app = initializeApp(firebaseConfig);
export const storage = getStorage(app);
export const functions = getFunctions(app);
export const db = getFirestore(app);
