# one-button-drawing

> ⚠️ **Test phase — incomplete.** This project is an early prototype under active
> development. Features are partial, APIs and data shapes may change, and some flows
> (e.g. password reset, a serverless key proxy) are stubbed or unfinished. It is not
> production-ready and is intended for internal testing and experimentation only.

one-button-drawing is an experimental, browser-based tool for rapidly sketching
architectural floor plans on an infinite canvas. You describe design rules in plain
English (e.g. minimum wall thickness) and lay out rooms whose relationships are driven
by an editable adjacency matrix; the app parses those constraints — via the Anthropic
LLM with a deterministic regex fallback — flags violations, and renders the resulting
partitions and facades. Sign-in (optional, via Firebase) persists your constraints and
matrix per account, while Guest mode runs everything locally without saving.

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
