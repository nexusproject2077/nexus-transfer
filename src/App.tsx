import { useState } from 'react';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { storage, functions } from './firebase';

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [progress, setProgress] = useState(0);

  const uploadFile = async () => {
    if (!file) return;
    const createTransfer = httpsCallable(functions, 'createTransfer');
    const result = await createTransfer({ fileName: file.name });

    const fileRef = ref(storage, `uploads/${result.data.id}-${file.name}`);
    const uploadTask = uploadBytesResumable(fileRef, file);

    uploadTask.on('state_changed', (snapshot) => {
      setProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
    }, (error) => console.error(error), () => {
      setLink(result.data.link);
    });
  };

  return (
    <div style={{ padding: '40px', textAlign: 'center' }}>
      <h1>🌌 Nexus Transfer</h1>
      <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      <button onClick={uploadFile} style={{margin: '20px'}}>Envoyer le fichier</button>
      {progress > 0 && <p>Progression : {progress}%</p>}
      {link && <p><a href={link} target="_blank" rel="noopener noreferrer">📎 {link}</a></p>}
    </div>
  );
}
