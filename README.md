# Nexus Transfer

Clone minimaliste de SwissTransfer sur Firebase.

L'utilisateur téléverse un fichier ; une Cloud Function crée un transfert
(document Firestore + fichier dans Cloud Storage) et renvoie un lien de
téléchargement à durée et nombre de téléchargements limités. Le fichier n'est
jamais lisible directement : chaque téléchargement passe par une URL signée
générée à la volée par la fonction `downloadTransfer`.

> ⚠️ L'usage de Cloud Storage impose le **plan Blaze** (pay-as-you-go).
> Le plan Spark ne donne pas accès au bucket.

## Architecture

- **Front** (`src/`) — React + Vite. Auth anonyme, appel de la fonction
  callable `createTransfer`, puis upload direct vers Storage.
- **Functions** (`functions/`) — Firebase Functions v2 (Node 24, TypeScript).
  - `createTransfer` (callable) — valide/borne les paramètres, crée le
    document Firestore, renvoie le lien.
  - `downloadTransfer` (HTTP) — vérifie expiration et quota, incrémente le
    compteur, redirige vers une URL signée v4.
- **Règles** — Firestore et Storage sont entièrement fermés côté client
  (`firestore.rules`, `storage.rules`), sauf l'écriture sur `uploads/`
  réservée aux sessions authentifiées.

## Configuration

Copie le modèle d'environnement et renseigne les valeurs de ton projet
(Console Firebase → Paramètres du projet → SDK Web) :

```bash
cp .env.example .env
```

Attention au bucket : c'est bien `nexus-transfer.firebasestorage.app`
(et non `.appspot.com`) qu'il faut mettre dans `VITE_FIREBASE_STORAGE_BUCKET`.

## Déploiement

```bash
npm install -g firebase-tools
firebase login

# Compilation + déploiement des Cloud Functions
cd functions && npm install && npm run build && cd ..
firebase deploy --only functions

# Règles Firestore + Storage
firebase deploy --only firestore:rules,storage
```
