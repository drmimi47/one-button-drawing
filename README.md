# one-button-drawing

One-button drawing description

## Sign-in setup (Firebase) — optional

The app shows a login popup for "Atom" on first visit. **Sign in** saves your edited
constraints and adjacency-matrix changes to your account and restores them on return;
**Guest** uses the app without saving. Sign-in is powered by Firebase and is **optional** —
until it's configured, the popup still appears but only the **Guest** button works.

To enable accounts:

1. Go to [console.firebase.google.com](https://console.firebase.google.com), create a
   project, then **Add app → Web**. Copy the `firebaseConfig` values.
2. **Build → Authentication → Sign-in method →** enable **Email/Password**.
3. **Build → Firestore Database → Create database** (Production mode). In the **Rules** tab,
   restrict each user to their own document:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

4. Copy `.env.example` to `.env.local` and fill in the `VITE_FIREBASE_*` values from step 1.
5. `npm install` (Firebase is already in `package.json`), then `npm run dev`.

Per-account data is stored in Firestore at `users/{uid}` as `{ constraintsText, adjacency }`.
Password reset is not wired up yet (the link is a placeholder).
