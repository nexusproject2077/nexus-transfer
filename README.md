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

- **Front** (`public/index.html`) — page statique unique (HTML + module ES,
  SDK Firebase chargé depuis le CDN). Auth anonyme, appel de la fonction
  callable `createTransfer`, puis upload direct vers Storage. La configuration
  Firebase est chargée à l'exécution depuis `/__/firebase/init.json` (servi
  automatiquement par Firebase Hosting) : aucune clé n'est codée en dur.
- **Functions** (`functions/`) — Firebase Functions v2 (Node 24, TypeScript).
  - `createTransfer` (callable) — valide/borne les paramètres, crée le
    document Firestore, renvoie le lien et le chemin de stockage.
  - `downloadTransfer` (HTTP) — vérifie expiration et quota, incrémente le
    compteur, redirige vers une URL signée v4.
- **Règles** — Firestore et Storage sont entièrement fermés côté client
  (`firestore.rules`, `storage.rules`), sauf l'écriture sur `uploads/`
  réservée aux sessions authentifiées.

## Déploiement

```bash
npm install -g firebase-tools
firebase login

# Front statique
firebase deploy --only hosting

# Compilation + déploiement des Cloud Functions
cd functions && npm install && npm run build && cd ..
firebase deploy --only functions

# Règles Firestore + Storage
firebase deploy --only firestore:rules,storage
```

Le front n'a aucune étape de build ni fichier `.env` : la config vient de
`/__/firebase/init.json`, donc rien à renseigner à la main.

> Génération d'URL signée (`downloadTransfer`) : le compte de service
> d'exécution des functions doit pouvoir signer. Activer l'API
> **IAM Service Account Credentials** et accorder au compte de service le rôle
> **Service Account Token Creator** (sinon `getSignedUrl` échoue avec une
> erreur `signBlob`).
