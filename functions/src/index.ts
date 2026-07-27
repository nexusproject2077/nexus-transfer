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
const MAX_FILES = 20;
const MAX_TOTAL_SIZE = 5 * 1024 * 1024 * 1024; // 5 Go, tous fichiers confondus
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;
const PREVIEW_URL_TTL_MS = 15 * 60 * 1000;

interface FileEntry {
  fileName: string;
  storagePath: string;
  contentType: string;
  size: number;
}

interface TransferDoc {
  files: FileEntry[];
  totalSize: number;
  expiresAt: Timestamp;
  maxDownloads: number;
  downloadCount: number;
  ownerUid: string | null;
  createdAt: FieldValue;
}

function toBoundedInt(value: unknown, fallback: number, max: number, min = 1): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._\- ]+/gu, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120);
}

function sanitizeContentType(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(raw) ? raw.slice(0, 120) : "application/octet-stream";
}

interface IncomingFile { fileName?: unknown; size?: unknown; contentType?: unknown; }

interface CreateTransferResponse {
  id: string;
  link: string;
  files: { storagePath: string }[];
  expiresAt: string;
}

export const createTransfer = onCall<{ files?: unknown; expiresDays?: unknown; maxDownloads?: unknown },
  Promise<CreateTransferResponse>>(async (request) => {
  const data = request.data ?? {};
  const incoming = Array.isArray(data.files) ? (data.files as IncomingFile[]) : [];

  if (incoming.length === 0) {
    throw new HttpsError("invalid-argument", "Au moins un fichier est requis.");
  }
  if (incoming.length > MAX_FILES) {
    throw new HttpsError("invalid-argument", `Maximum ${MAX_FILES} fichiers par transfert.`);
  }

  const id = randomUUID();
  const files: FileEntry[] = incoming.map((f, index) => {
    const rawName = typeof f.fileName === "string" ? f.fileName.trim() : "";
    if (!rawName) throw new HttpsError("invalid-argument", "Chaque fichier doit avoir un nom.");
    const fileName = sanitizeFileName(rawName);
    return {
      fileName,
      storagePath: `uploads/${id}/${index}-${fileName}`,
      contentType: sanitizeContentType(f.contentType),
      size: toBoundedInt(f.size, 0, MAX_TOTAL_SIZE, 0),
    };
  });

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    throw new HttpsError("invalid-argument", "La taille totale dépasse la limite de 5 Go.");
  }

  const expiresDays = toBoundedInt(data.expiresDays, 7, MAX_EXPIRES_DAYS);
  const maxDownloads = toBoundedInt(data.maxDownloads, 10, MAX_DOWNLOADS_LIMIT);
  const expiresAt = Timestamp.fromMillis(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

  const doc: TransferDoc = {
    files,
    totalSize,
    expiresAt,
    maxDownloads,
    downloadCount: 0,
    ownerUid: request.auth?.uid ?? null,
    createdAt: FieldValue.serverTimestamp(),
  };
  await db.collection("transfers").doc(id).set(doc);

  const projectId = process.env.GCLOUD_PROJECT ?? "nexus-transfer";
  logger.info("Transfert créé", { id, files: files.length, totalSize, expiresDays, maxDownloads });

  return {
    id,
    link: `https://${projectId}.web.app/d/${id}`,
    files: files.map((f) => ({ storagePath: f.storagePath })),
    expiresAt: expiresAt.toDate().toISOString(),
  };
});

interface PublicFile {
  fileName: string;
  size: number;
  contentType: string;
  previewUrl: string | null;
}

interface TransferInfo {
  available: boolean;
  reason: "ok" | "not_found" | "expired" | "exhausted" | "pending";
  files: PublicFile[];
  totalSize: number | null;
  expiresAt: string | null;
  downloadCount: number | null;
  maxDownloads: number | null;
}

export const getTransferInfo = onCall<{ id?: unknown }, Promise<TransferInfo>>(async (request) => {
  const id = typeof request.data?.id === "string" ? request.data.id : "";
  const empty: TransferInfo = {
    available: false, reason: "not_found", files: [], totalSize: null,
    expiresAt: null, downloadCount: null, maxDownloads: null,
  };
  if (!id) return empty;

  const snapshot = await db.collection("transfers").doc(id).get();
  if (!snapshot.exists) return empty;

  const transfer = snapshot.data() as TransferDoc;
  const base: TransferInfo = {
    available: false, reason: "ok",
    files: transfer.files.map((f) => ({ fileName: f.fileName, size: f.size, contentType: f.contentType, previewUrl: null })),
    totalSize: transfer.totalSize ?? null,
    expiresAt: transfer.expiresAt.toDate().toISOString(),
    downloadCount: transfer.downloadCount,
    maxDownloads: transfer.maxDownloads,
  };

  if (transfer.expiresAt.toMillis() < Date.now()) return { ...base, reason: "expired" };
  if (transfer.downloadCount >= transfer.maxDownloads) return { ...base, reason: "exhausted" };

  const bucket = getStorage().bucket();
  const previews = await Promise.all(transfer.files.map(async (f) => {
    const file = bucket.file(f.storagePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [url] = await file.getSignedUrl({
      version: "v4", action: "read", expires: Date.now() + PREVIEW_URL_TTL_MS,
      responseDisposition: `inline; filename="${encodeURIComponent(f.fileName)}"`,
    });
    return url;
  }));

  if (previews.every((p) => p === null)) return { ...base, reason: "pending" };

  const files = base.files.map((f, i) => ({ ...f, previewUrl: previews[i] }));
  return { ...base, available: true, files };
});

/**
 * Sert un fichier d'un transfert : /dl/<id>/<index>. Vérifie les quotas,
 * incrémente le compteur, redirige vers une URL signée en pièce jointe.
 */
export const downloadTransfer = onRequest(async (req, res) => {
  const segments = req.path.split("/").filter((s) => s && s !== "dl");
  const id = segments[0] ?? "";
  const index = segments.length > 1 ? Number.parseInt(segments[1], 10) : 0;

  if (!id) {
    res.status(400).send("Identifiant de transfert manquant.");
    return;
  }

  const docRef = db.collection("transfers").doc(id);
  const snapshot = await docRef.get();
  if (!snapshot.exists) { res.redirect(302, `/d/${id}`); return; }

  const transfer = snapshot.data() as TransferDoc;
  if (transfer.expiresAt.toMillis() < Date.now() || transfer.downloadCount >= transfer.maxDownloads) {
    res.redirect(302, `/d/${id}`); return;
  }

  const entry = transfer.files[Number.isFinite(index) ? index : 0];
  if (!entry) { res.redirect(302, `/d/${id}`); return; }

  const file = getStorage().bucket().file(entry.storagePath);
  const [exists] = await file.exists();
  if (!exists) { res.redirect(302, `/d/${id}`); return; }

  const [signedUrl] = await file.getSignedUrl({
    version: "v4", action: "read", expires: Date.now() + DOWNLOAD_URL_TTL_MS,
    responseDisposition: `attachment; filename="${encodeURIComponent(entry.fileName)}"`,
  });

  await docRef.update({ downloadCount: FieldValue.increment(1), lastDownloadAt: FieldValue.serverTimestamp() });
  res.redirect(302, signedUrl);
});
