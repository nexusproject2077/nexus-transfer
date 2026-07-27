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
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 Go
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;
const PREVIEW_URL_TTL_MS = 15 * 60 * 1000;

interface TransferDoc {
  fileName: string;
  storagePath: string;
  contentType: string;
  size: number;
  expiresAt: Timestamp;
  maxDownloads: number;
  downloadCount: number;
  ownerUid: string | null;
  createdAt: FieldValue;
}

/**
 * Borne une valeur numérique reçue du client entre `min` et `max`.
 */
function toBoundedInt(value: unknown, fallback: number, max: number, min = 1): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * Neutralise les caractères dangereux dans un nom de fichier fourni par le
 * client (traversée de répertoire, caractères de contrôle).
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._\- ]+/gu, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
}

/**
 * Valide sommairement un type MIME fourni par le client.
 */
function sanitizeContentType(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(raw) ? raw.slice(0, 120) : "application/octet-stream";
}

interface CreateTransferRequest {
  fileName?: unknown;
  size?: unknown;
  contentType?: unknown;
  expiresDays?: unknown;
  maxDownloads?: unknown;
}

interface CreateTransferResponse {
  id: string;
  storagePath: string;
  link: string;
  expiresAt: string;
}

export const createTransfer = onCall<CreateTransferRequest, Promise<CreateTransferResponse>>(
  async (request) => {
    const data = request.data ?? {};

    const rawFileName = typeof data.fileName === "string" ? data.fileName.trim() : "";
    if (!rawFileName) {
      throw new HttpsError("invalid-argument", "Le champ 'fileName' est requis.");
    }

    const fileName = sanitizeFileName(rawFileName);
    const contentType = sanitizeContentType(data.contentType);
    const size = toBoundedInt(data.size, 0, MAX_FILE_SIZE, 0);
    const expiresDays = toBoundedInt(data.expiresDays, 7, MAX_EXPIRES_DAYS);
    const maxDownloads = toBoundedInt(data.maxDownloads, 10, MAX_DOWNLOADS_LIMIT);

    const id = randomUUID();
    const storagePath = `uploads/${id}-${fileName}`;
    const expiresAt = Timestamp.fromMillis(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

    const doc: TransferDoc = {
      fileName,
      storagePath,
      contentType,
      size,
      expiresAt,
      maxDownloads,
      downloadCount: 0,
      ownerUid: request.auth?.uid ?? null,
      createdAt: FieldValue.serverTimestamp(),
    };
    await db.collection("transfers").doc(id).set(doc);

    const projectId = process.env.GCLOUD_PROJECT ?? "nexus-transfer";
    const link = `https://${projectId}.web.app/d/${id}`;

    logger.info("Transfert créé", { id, fileName, size, expiresDays, maxDownloads });

    return {
      id,
      storagePath,
      link,
      expiresAt: expiresAt.toDate().toISOString(),
    };
  }
);

interface TransferInfo {
  available: boolean;
  reason: "ok" | "not_found" | "expired" | "exhausted" | "pending";
  fileName: string | null;
  size: number | null;
  contentType: string | null;
  expiresAt: string | null;
  downloadCount: number | null;
  maxDownloads: number | null;
  previewUrl: string | null;
}

/**
 * Renvoie les métadonnées publiques d'un transfert (pour la page de
 * téléchargement) et une URL signée de prévisualisation. N'incrémente PAS le
 * compteur de téléchargements : la prévisualisation est gratuite.
 */
export const getTransferInfo = onCall<{ id?: unknown }, Promise<TransferInfo>>(async (request) => {
  const id = typeof request.data?.id === "string" ? request.data.id : "";
  const empty: TransferInfo = {
    available: false,
    reason: "not_found",
    fileName: null,
    size: null,
    contentType: null,
    expiresAt: null,
    downloadCount: null,
    maxDownloads: null,
    previewUrl: null,
  };

  if (!id) {
    return empty;
  }

  const snapshot = await db.collection("transfers").doc(id).get();
  if (!snapshot.exists) {
    return empty;
  }

  const transfer = snapshot.data() as TransferDoc;
  const base: TransferInfo = {
    available: false,
    reason: "ok",
    fileName: transfer.fileName,
    size: transfer.size ?? null,
    contentType: transfer.contentType ?? "application/octet-stream",
    expiresAt: transfer.expiresAt.toDate().toISOString(),
    downloadCount: transfer.downloadCount,
    maxDownloads: transfer.maxDownloads,
    previewUrl: null,
  };

  if (transfer.expiresAt.toMillis() < Date.now()) {
    return { ...base, reason: "expired" };
  }
  if (transfer.downloadCount >= transfer.maxDownloads) {
    return { ...base, reason: "exhausted" };
  }

  const file = getStorage().bucket().file(transfer.storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    return { ...base, reason: "pending" };
  }

  const [previewUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + PREVIEW_URL_TTL_MS,
    responseDisposition: `inline; filename="${encodeURIComponent(transfer.fileName)}"`,
  });

  return { ...base, available: true, previewUrl };
});

/**
 * Sert le fichier : vérifie les quotas, incrémente le compteur, puis redirige
 * vers une URL signée en pièce jointe. En cas d'indisponibilité, renvoie
 * l'utilisateur vers la page /d/<id> qui affichera l'état.
 */
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
    res.redirect(302, `/d/${id}`);
    return;
  }

  const transfer = snapshot.data() as TransferDoc;

  if (transfer.expiresAt.toMillis() < Date.now() || transfer.downloadCount >= transfer.maxDownloads) {
    res.redirect(302, `/d/${id}`);
    return;
  }

  const file = getStorage().bucket().file(transfer.storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    res.redirect(302, `/d/${id}`);
    return;
  }

  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + DOWNLOAD_URL_TTL_MS,
    responseDisposition: `attachment; filename="${encodeURIComponent(transfer.fileName)}"`,
  });

  await docRef.update({
    downloadCount: FieldValue.increment(1),
    lastDownloadAt: FieldValue.serverTimestamp(),
  });

  res.redirect(302, signedUrl);
});
