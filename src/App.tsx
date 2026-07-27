import { useState } from 'react';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { signInAnonymously } from 'firebase/auth';
import { storage, functions, auth } from './firebase';

interface CreateTransferRequest {
  fileName: string;
  expiresDays?: number;
  maxDownloads?: number;
}

interface CreateTransferResponse {
  id: string;
  storagePath: string;
  link: string;
  expiresAt: string;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const uploadFile = async () => {
    if (!file || busy) return;

    setError('');
    setLink('');
    setProgress(0);
    setBusy(true);

    try {
      // Les règles Storage exigent une session authentifiée : l'auth anonyme
      // suffit et reste transparente pour l'utilisateur.
      if (!auth.currentUser) {
        await signInAnonymously(auth);
      }

      const createTransfer = httpsCallable<CreateTransferRequest, CreateTransferResponse>(
        functions,
        'createTransfer'
      );

      const result = await createTransfer({
        fileName: file.name,
        expiresDays: 7,
        maxDownloads: 10,
      });

      // On réutilise le chemin calculé par le serveur plutôt que de le
      // reconstruire côté client : les deux doivent rester synchronisés.
      const fileRef = ref(storage, result.data.storagePath);
      const uploadTask = uploadBytesResumable(fileRef, file);

      uploadTask.on(
        'state_changed',
        (snapshot) => {
          setProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
        },
        (uploadError) => {
          console.error(uploadError);
          setError("Le téléversement a échoué : " + uploadError.message);
          setBusy(false);
        },
        () => {
          setLink(result.data.link);
          setBusy(false);
        }
      );
    } catch (callError) {
      console.error(callError);
      setError("Impossible de créer le transfert : " + (callError as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '40px', textAlign: 'center' }}>
      <h1>🌌 Nexus Transfer</h1>

      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        disabled={busy}
      />

      <button onClick={uploadFile} disabled={!file || busy} style={{ margin: '20px' }}>
        {busy ? 'Envoi en cours…' : 'Envoyer le fichier'}
      </button>

      {progress > 0 && <p>Progression : {progress}%</p>}

      {link && (
        <p>
          <a href={link} target="_blank" rel="noopener noreferrer">
            📎 {link}
          </a>
        </p>
      )}

      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
    </div>
  );
}
