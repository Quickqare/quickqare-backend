const admin = require("firebase-admin");

const buildServiceAccountFromEnv = () => {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  // In .env, private keys are commonly stored with literal "\n"
  // sequences. Convert those back into real newlines.
  const privateKeyRaw = String(process.env.FIREBASE_PRIVATE_KEY || "");
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n").trim();

  if (!projectId || !clientEmail || !privateKey) return null;

  return {
    projectId,
    clientEmail,
    privateKey,
  };
};

if (!admin.apps.length) {
  const serviceAccount = buildServiceAccountFromEnv();

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    // Don't crash the whole server if Firebase isn't configured.
    // Push notifications will just be disabled until env vars are set.
    console.warn(
      "[firebase] Not initialized. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env"
    );
  }
}

module.exports = admin;
