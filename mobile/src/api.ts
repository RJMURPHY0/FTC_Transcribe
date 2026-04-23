const BASE = 'https://ftctranscribe-phi.vercel.app';

export interface Recording {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  folderId: string | null;
  folder: { id: string; name: string } | null;
  summary: {
    overview: string;
    keyPoints: string;
    actionItems: string;
    decisions: string;
  } | null;
  _count: { chunks: number };
}

export interface RecordingDetail extends Recording {
  transcript: { fullText: string; segments: string } | null;
}

export async function getRecordings(): Promise<Recording[]> {
  const res = await fetch(`${BASE}/api/recordings`);
  if (!res.ok) throw new Error('Failed to fetch recordings');
  return res.json();
}

export async function getRecording(id: string): Promise<RecordingDetail> {
  const res = await fetch(`${BASE}/api/recordings/${id}`);
  if (!res.ok) throw new Error('Recording not found');
  return res.json();
}

export async function createRecording(): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/recordings/create`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create recording');
  return res.json();
}

export async function uploadChunk(
  recordingId: string,
  fileUri: string,
  offset: number,
): Promise<void> {
  const formData = new FormData();
  formData.append('audio', {
    uri: fileUri,
    type: 'audio/m4a',
    name: 'chunk.m4a',
  } as unknown as Blob);
  formData.append('offset', String(offset));

  let lastErr = new Error('Upload failed');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const res = await fetch(`${BASE}/api/recordings/${recordingId}/append-chunk`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Server error ${res.status}`);
      }
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Upload failed');
    }
  }
  throw lastErr;
}

export async function finalizeRecording(recordingId: string): Promise<void> {
  fetch(`${BASE}/api/recordings/${recordingId}/finalize`, {
    method: 'POST',
  }).catch(() => {});
}

export async function deleteRecording(id: string): Promise<void> {
  await fetch(`${BASE}/api/recordings/${id}`, { method: 'DELETE' });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
