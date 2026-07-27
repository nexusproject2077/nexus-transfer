import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const db = getFirestore();

const MAX_EXPIRES_DAYS = 30;
const MAX_DOWNLOADS_LIMIT = 1000;
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

interface CreateTransferRequest {
  fileName?: unknown;
  expiresDays?: unknown;
  maxDownloads?: unknown;
}

interface CreateTransferResponse {
  id: string;
  storagePath: string;
  link: string;
  expiresAt: string;
}

/**
 * Borne une valeur numérique reçue du client entre 1 et une limite maximale.
 */
function toBoundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

/**
 * Neutralise les caractères dangereux dans un nom de fichier fourni par le client
 * (traversée de répertoire, caractères de contrôle).
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._\- ]+/gu, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
}

export const createTransfer = onCall<CreateTransferRequest, Promise<CreateTransferResponse>>(
  async (request) => {
    const data = request.data ?? {};

    const rawFileName = typeof data.fileName === "string" ? data.fileName.trim() : "";
    if (!rawFileName) {
      throw new HttpsError("invalid-argument", "Le champ 'fileName' est requis.");
    }

    const fileName = sanitizeFileName(rawFileName);
    const expiresDays = toBoundedInt(data.expiresDays, 7, MAX_EXPIRES_DAYS);
    const maxDownloads = toBoundedInt(data.maxDownloads, 10, MAX_DOWNLOADS_LIMIT);

    const id = randomUUID();
    const storagePath = `uploads/${id}-${fileName}`;
    const expiresAt = Timestamp.fromMillis(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

    await db.collection("transfers").doc(id).set({
      fileName,
      storagePath,
      expiresAt,
      maxDownloads,
      downloadCount: 0,
      ownerUid: request.auth?.uid ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });

    const projectId = process.env.GCLOUD_PROJECT ?? "nexus-transfer";
    const link = `https://${projectId}.web.app/d/${id}`;

    logger.info("Transfert créé", { id, fileName, expiresDays, maxDownloads });

    return {
      id,
      storagePath,
      link,
      expiresAt: expiresAt.toDate().toISOString(),
    };
  }
);

export const downloadTransfer = onRequest(async (req, res) => {
  const segments = req.path.split("/").filter(Boolean);
  const id = segments[segments.length - 1] ?? "";

  if (!id) {
    res.status(400).send("Identifiant de transfert manquant.");
    return;
  }

  const docRef = db.collection("transfers").doc(id);
  const snapshot = await docRef.get();

  if (!snapshot.exists) {
    res.status(404).send("Ce transfert n'existe pas.");
    return;
  }

  const transfer = snapshot.data() as {
    fileName: string;
    storagePath: string;
    expiresAt: Timestamp;
    maxDownloads: number;
    downloadCount: number;
  };

  if (transfer.expiresAt.toMillis() < Date.now()) {
    res.status(410).send("Ce transfert a expiré.");
    return;
  }

  if (transfer.downloadCount >= transfer.maxDownloads) {
    res.status(410).send("Ce transfert a atteint son nombre maximum de téléchargements.");
    return;
  }

  const file = getStorage().bucket().file(transfer.storagePath);
  const [exists] = await file.exists();

  if (!exists) {
    res.status(404).send("Le fichier n'a pas encore été téléversé, ou a été supprimé.");
    return;
  }

  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + SIGNED_URL_TTL_MS,
    responseDisposition: `attachment; filename="${encodeURIComponent(transfer.fileName)}"`,
  });

  await docRef.update({
    downloadCount: FieldValue.increment(1),
    lastDownloadAt: FieldValue.serverTimestamp(),
  });

  res.redirect(302, signedUrl);
});
