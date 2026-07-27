"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadTransfer = exports.getTransferInfo = exports.createTransfer = void 0;
const node_crypto_1 = require("node:crypto");
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const options_1 = require("firebase-functions/v2/options");
const https_1 = require("firebase-functions/v2/https");
const firebase_functions_1 = require("firebase-functions");
(0, app_1.initializeApp)();
(0, options_1.setGlobalOptions)({ region: "us-central1", maxInstances: 10 });
const db = (0, firestore_1.getFirestore)();
const MAX_EXPIRES_DAYS = 30;
const MAX_DOWNLOADS_LIMIT = 1000;
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 Go
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;
const PREVIEW_URL_TTL_MS = 15 * 60 * 1000;
/**
 * Borne une valeur numérique reçue du client entre `min` et `max`.
 */
function toBoundedInt(value, fallback, max, min = 1) {
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
function sanitizeFileName(name) {
    return name
        .replace(/[\\/]/g, "_")
        .replace(/[^\p{L}\p{N}._\- ]+/gu, "_")
        .replace(/^\.+/, "_")
        .slice(0, 120);
}
/**
 * Valide sommairement un type MIME fourni par le client.
 */
function sanitizeContentType(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    return /^[\w.+-]+\/[\w.+-]+$/.test(raw) ? raw.slice(0, 120) : "application/octet-stream";
}
exports.createTransfer = (0, https_1.onCall)(async (request) => {
    const data = request.data ?? {};
    const rawFileName = typeof data.fileName === "string" ? data.fileName.trim() : "";
    if (!rawFileName) {
        throw new https_1.HttpsError("invalid-argument", "Le champ 'fileName' est requis.");
    }
    const fileName = sanitizeFileName(rawFileName);
    const contentType = sanitizeContentType(data.contentType);
    const size = toBoundedInt(data.size, 0, MAX_FILE_SIZE, 0);
    const expiresDays = toBoundedInt(data.expiresDays, 7, MAX_EXPIRES_DAYS);
    const maxDownloads = toBoundedInt(data.maxDownloads, 10, MAX_DOWNLOADS_LIMIT);
    const id = (0, node_crypto_1.randomUUID)();
    const storagePath = `uploads/${id}-${fileName}`;
    const expiresAt = firestore_1.Timestamp.fromMillis(Date.now() + expiresDays * 24 * 60 * 60 * 1000);
    const doc = {
        fileName,
        storagePath,
        contentType,
        size,
        expiresAt,
        maxDownloads,
        downloadCount: 0,
        ownerUid: request.auth?.uid ?? null,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    };
    await db.collection("transfers").doc(id).set(doc);
    const projectId = process.env.GCLOUD_PROJECT ?? "nexus-transfer";
    const link = `https://${projectId}.web.app/d/${id}`;
    firebase_functions_1.logger.info("Transfert créé", { id, fileName, size, expiresDays, maxDownloads });
    return {
        id,
        storagePath,
        link,
        expiresAt: expiresAt.toDate().toISOString(),
    };
});
/**
 * Renvoie les métadonnées publiques d'un transfert (pour la page de
 * téléchargement) et une URL signée de prévisualisation. N'incrémente PAS le
 * compteur de téléchargements : la prévisualisation est gratuite.
 */
exports.getTransferInfo = (0, https_1.onCall)(async (request) => {
    const id = typeof request.data?.id === "string" ? request.data.id : "";
    const empty = {
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
    const transfer = snapshot.data();
    const base = {
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
    const file = (0, storage_1.getStorage)().bucket().file(transfer.storagePath);
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
exports.downloadTransfer = (0, https_1.onRequest)(async (req, res) => {
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
    const transfer = snapshot.data();
    if (transfer.expiresAt.toMillis() < Date.now() || transfer.downloadCount >= transfer.maxDownloads) {
        res.redirect(302, `/d/${id}`);
        return;
    }
    const file = (0, storage_1.getStorage)().bucket().file(transfer.storagePath);
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
        downloadCount: firestore_1.FieldValue.increment(1),
        lastDownloadAt: firestore_1.FieldValue.serverTimestamp(),
    });
    res.redirect(302, signedUrl);
});
//# sourceMappingURL=index.js.map