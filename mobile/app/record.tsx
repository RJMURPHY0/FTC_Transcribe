import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { createRecording, finalizeRecording, uploadChunk } from '../src/api';

type State = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

const CHUNK_MS = 2 * 60 * 1000; // 2 minutes per chunk

function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// Recording options: mono AAC M4A — good quality, small file, supported by server
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: '.m4a',
    outputFormat: 2,  // MPEG_4
    audioEncoder: 3,  // AAC
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.m4a',
    outputFormat: '.mp4',
    audioQuality: 96,   // MEDIUM
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
};

export default function RecordScreen() {
  const [state, setState]           = useState<State>('idle');
  const [seconds, setSeconds]       = useState(0);
  const [chunksSaved, setChunksSaved] = useState(0);
  const [errorMsg, setErrorMsg]     = useState('');

  const recordingRef    = useRef<Audio.Recording | null>(null);
  const recordingIdRef  = useRef<string | null>(null);
  const isActiveRef     = useRef(false);
  const chunkTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeOffsetRef   = useRef(0);
  const chunkStartRef   = useRef(0);

  // Elapsed timer
  useEffect(() => {
    if (state === 'recording') {
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state]);

  // Warn if user tries to leave mid-recording
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' && state === 'recording') {
        // Audio continues in background — this is fine, just log
        console.log('[record] moved to background — recording continues');
      }
    });
    return () => sub.remove();
  }, [state]);

  const stopChunkTimer = () => {
    if (chunkTimerRef.current) {
      clearTimeout(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
  };

  const startChunk = useCallback(async () => {
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(RECORDING_OPTIONS);
    await rec.startAsync();
    recordingRef.current = rec;
    chunkStartRef.current = Date.now();

    // Auto-rotate after CHUNK_MS
    chunkTimerRef.current = setTimeout(async () => {
      if (isActiveRef.current) {
        await rotateChunk();
      }
    }, CHUNK_MS);
  }, []);                        // rotateChunk defined below

  const rotateChunk = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec) return;

    stopChunkTimer();
    await rec.stopAndUnloadAsync();
    recordingRef.current = null;

    const uri = rec.getURI();
    const offset = timeOffsetRef.current;
    const chunkDuration = (Date.now() - chunkStartRef.current) / 1000;
    timeOffsetRef.current += chunkDuration;

    if (uri) {
      try {
        await uploadChunk(recordingIdRef.current!, uri, offset);
        setChunksSaved((n) => n + 1);
      } catch (err) {
        console.warn('[record] chunk upload failed:', err);
        // Don't abort — keep recording, retry on next chunk
      }
    }

    if (isActiveRef.current) {
      await startChunk();
    } else {
      // Final chunk done — kick off finalization
      setState('uploading');
      const id = recordingIdRef.current;
      if (id) {
        finalizeRecording(id);
        setState('done');
        router.replace(`/recording/${id}`);
      }
    }
  }, [startChunk]);

  const start = useCallback(async () => {
    setErrorMsg('');
    setSeconds(0);
    setChunksSaved(0);

    try {
      // Request permissions
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        setErrorMsg('Microphone permission denied. Please allow it in Settings.');
        setState('error');
        return;
      }

      // Configure audio session for background recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        staysActiveInBackground: true,  // KEY: continues when screen locks
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: false,
      });

      const { id } = await createRecording();
      recordingIdRef.current = id;
      timeOffsetRef.current = 0;
      isActiveRef.current = true;

      await startChunk();
      setState('recording');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not start recording');
      setState('error');
    }
  }, [startChunk]);

  const stop = useCallback(async () => {
    if (state !== 'recording') return;
    isActiveRef.current = false;
    stopChunkTimer();
    setState('uploading');

    try {
      await rotateChunk();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save recording');
      setState('error');
    }
  }, [state, rotateChunk]);

  const handlePress = () => {
    if (state === 'idle') void start();
    else if (state === 'recording') void stop();
  };

  const isProcessing = state === 'uploading' || state === 'done';

  return (
    <View style={styles.container}>
      {/* Timer */}
      <View style={styles.timerContainer}>
        <Text style={[styles.timer, state === 'recording' && styles.timerActive]}>
          {formatTime(seconds)}
        </Text>
        {state === 'recording' && (
          <View style={styles.recRow}>
            <View style={styles.recDot} />
            <Text style={styles.recLabel}>REC</Text>
          </View>
        )}
      </View>

      {/* Button */}
      <Pressable
        style={({ pressed }) => [
          styles.btn,
          state === 'recording' ? styles.btnStop : styles.btnStart,
          (isProcessing || pressed) && styles.btnDimmed,
        ]}
        onPress={handlePress}
        disabled={isProcessing}
      >
        {isProcessing ? (
          <View style={styles.spinner} />
        ) : state === 'recording' ? (
          <View style={styles.stopSquare} />
        ) : (
          <View style={styles.micDot} />
        )}
      </Pressable>

      {/* Status */}
      <View style={styles.statusBox}>
        <Text style={styles.statusText}>
          {state === 'idle'      && 'Tap to start recording'}
          {state === 'recording' && 'Recording — tap to stop'}
          {state === 'uploading' && 'Saving final segment…'}
          {state === 'done'      && 'Done — loading your recording…'}
          {state === 'error'     && 'Something went wrong'}
        </Text>

        {state === 'recording' && chunksSaved > 0 && (
          <Text style={styles.statusSub}>
            {chunksSaved} segment{chunksSaved !== 1 ? 's' : ''} saved safely
          </Text>
        )}

        {state === 'recording' && (
          <Text style={styles.statusHint}>
            Screen can lock — recording continues in background
          </Text>
        )}

        {state === 'error' && errorMsg ? (
          <Text style={styles.errorText}>{errorMsg}</Text>
        ) : null}

        {state === 'error' && (
          <Pressable onPress={() => setState('idle')} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        )}
      </View>

      {state === 'idle' && (
        <Text style={styles.hint}>
          Records in 2-minute segments. Once you stop, transcription runs on our
          servers — you can lock or close your phone immediately.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#030712',
    alignItems: 'center', justifyContent: 'center', gap: 40, paddingHorizontal: 32,
  },
  timerContainer: { alignItems: 'center', gap: 8 },
  timer: { fontSize: 72, fontWeight: '700', fontVariant: ['tabular-nums'], color: '#374151' },
  timerActive: { color: '#f9fafb' },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
  recLabel: { fontSize: 11, fontWeight: '700', color: '#f87171', letterSpacing: 3 },

  btn: {
    width: 120, height: 120, borderRadius: 60,
    alignItems: 'center', justifyContent: 'center',
  },
  btnStart: { backgroundColor: '#f97316' },
  btnStop: { backgroundColor: '#ef4444' },
  btnDimmed: { opacity: 0.6 },
  stopSquare: { width: 40, height: 40, borderRadius: 8, backgroundColor: '#fff' },
  micDot: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#fff' },
  spinner: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
  },

  statusBox: { alignItems: 'center', gap: 6 },
  statusText: { fontSize: 15, fontWeight: '600', color: '#f9fafb', textAlign: 'center' },
  statusSub: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
  statusHint: { fontSize: 12, color: '#f97316', textAlign: 'center', marginTop: 4 },
  errorText: { fontSize: 13, color: '#f87171', textAlign: 'center' },
  retryBtn: { marginTop: 8, padding: 8 },
  retryText: { color: '#f97316', fontWeight: '600' },

  hint: {
    fontSize: 12, color: '#4b5563', textAlign: 'center', lineHeight: 18, maxWidth: 280,
  },
});
