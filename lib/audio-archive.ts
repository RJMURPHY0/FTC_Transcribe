import { prisma } from '@/lib/db';
import { getAdminClient } from '@/lib/supabase/admin';

export const RECORDING_AUDIO_BUCKET = 'recording-audio';

// Extension is cosmetic — playback uses the stored Content-Type.
function extFor(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

// Move a recording's audio out of the ChunkBlob table into Supabase Storage so
// it survives finalize (which purges chunks) and stays playable forever.
// Returns true only when the merged audio is safely in the bucket and
// Recording.audioPath points at it — the caller may then delete the chunks.
// Without SUPABASE_SERVICE_ROLE_KEY this returns false and the caller keeps
// the chunks in the DB, which the audio route can still serve.
export async function archiveRecordingAudio(recordingId: string): Promise<boolean> {
  try {
    const existing = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { audioPath: true },
    });
    if (existing?.audioPath) return true; // already archived

    const admin = getAdminClient();
    if (!admin) return false;

    const chunks = await prisma.chunkBlob.findMany({
      where: { recordingId },
      orderBy: { offset: 'asc' },
      select: { audioData: true, mimeType: true },
    });
    if (chunks.length === 0) return false;

    const total = chunks.reduce((sum, c) => sum + c.audioData.length, 0);
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(new Uint8Array(c.audioData), pos);
      pos += c.audioData.length;
    }

    const mimeType = (chunks[0].mimeType || 'audio/webm').split(';')[0].trim();
    const objectPath = `${recordingId}.${extFor(mimeType)}`;

    const { error } = await admin.storage
      .from(RECORDING_AUDIO_BUCKET)
      .upload(objectPath, merged, { contentType: mimeType, upsert: true });
    if (error) {
      console.warn(`[audio-archive] upload failed for ${recordingId}:`, error.message);
      return false;
    }

    await prisma.recording.update({
      where: { id: recordingId },
      data: { audioPath: `${RECORDING_AUDIO_BUCKET}/${objectPath}`, mimeType },
    });
    console.log(`[audio-archive] archived ${recordingId} (${Math.round(total / 1024)} KB)`);
    return true;
  } catch (err) {
    console.warn(`[audio-archive] failed for ${recordingId}:`, err);
    return false;
  }
}

// Best-effort removal when a recording is hard-deleted.
export async function deleteArchivedAudio(audioPath: string): Promise<void> {
  if (!audioPath) return;
  const admin = getAdminClient();
  if (!admin) return;
  const [bucket, ...rest] = audioPath.split('/');
  if (!bucket || rest.length === 0) return;
  await admin.storage.from(bucket).remove([rest.join('/')]).then(
    r => { if (r.error) console.warn('[audio-archive] delete failed:', r.error.message); },
    () => {},
  );
}
