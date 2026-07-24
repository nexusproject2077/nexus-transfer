import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
admin.initializeApp();

export const createTransfer = functions.https.onCall(async (data, context) => {
  const { fileName, expiresDays = 7, maxDownloads = 10 } = data;
  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
  );

  const transferRef = admin.firestore().collection("transfers").doc();
  await transferRef.set({
    fileName,
    expiresAt,
    maxDownloads,
    downloadCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    filePath: `uploads/${transferRef.id}-${fileName}`
  });

  return {
    id: transferRef.id,
    link: `https://nexus-transfer.web.app/transfer/${transferRef.id}`
  };
});
