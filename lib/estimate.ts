// Lightweight, dependency-free helpers safe to import into server components.
// Kept separate from lib/finalize-recording so pages don't pull the native
// transcription/voice-id chain (sherpa-onnx, onnxruntime) into their render
// tree — that chain crashes the Next.js render worker locally.

export function estimateSeconds(chunkCount: number): number {
  return 45 + Math.min(chunkCount * 3, 30);
}
