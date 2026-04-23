import { useLocalSearchParams, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';
import { getRecording, RecordingDetail } from '../../src/api';

function safeJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

interface Segment { speaker: string; start: number; end: number; text: string }

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

const SPEAKER_COLOURS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
function speakerColour(speaker: string) {
  const n = parseInt(speaker.replace(/\D/g, '') || '1', 10) - 1;
  return SPEAKER_COLOURS[n % SPEAKER_COLOURS.length];
}

export default function RecordingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [rec, setRec] = useState<RecordingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getRecording(id);
      setRec(data);
      if (data.status === 'completed' || data.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  // Poll every 8s while processing
  useEffect(() => {
    if (!rec) return;
    if (rec.status === 'uploading' || rec.status === 'queued' || rec.status === 'processing') {
      pollRef.current = setInterval(() => void load(), 8000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [rec?.status, load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#f97316" size="large" />
      </View>
    );
  }

  if (error || !rec) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error || 'Recording not found'}</Text>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const isQueued = rec.status === 'uploading' || rec.status === 'queued' || rec.status === 'processing';
  const actions  = safeJson<string[]>(rec.summary?.actionItems, []);
  const points   = safeJson<string[]>(rec.summary?.keyPoints,   []);
  const decisions = safeJson<string[]>(rec.summary?.decisions,  []);

  const rawSegments = safeJson<Segment[]>(rec.transcript?.segments, []);
  // Merge consecutive same-speaker segments
  const segments = rawSegments.reduce<Segment[]>((groups, seg) => {
    const last = groups[groups.length - 1];
    if (last && last.speaker === seg.speaker) {
      groups[groups.length - 1] = { ...last, text: last.text + ' ' + seg.text.trim(), end: seg.end };
    } else {
      groups.push({ ...seg, text: seg.text.trim() });
    }
    return groups;
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Title */}
      <Text style={styles.title}>{rec.title || 'Untitled Recording'}</Text>

      {/* Processing banner */}
      {isQueued && (
        <View style={styles.banner}>
          <ActivityIndicator color="#60a5fa" size="small" />
          <Text style={styles.bannerText}>
            {rec.status === 'processing' ? 'Analysing…' : 'Queued for transcription…'}
            {' '}This page updates automatically.
          </Text>
        </View>
      )}
      {rec.status === 'failed' && (
        <View style={[styles.banner, styles.bannerFailed]}>
          <Text style={styles.bannerFailedText}>Transcription failed — tap Retry on the web app to reprocess.</Text>
        </View>
      )}

      {/* Summary */}
      {rec.summary && (
        <>
          <Section title="Overview">
            <Text style={styles.body}>{rec.summary.overview}</Text>
          </Section>

          {points.length > 0 && (
            <Section title="Key Points">
              {points.map((p, i) => <BulletItem key={i} text={p} />)}
            </Section>
          )}

          {actions.length > 0 && (
            <Section title="Action Items">
              {actions.map((a, i) => <BulletItem key={i} text={a} accent="#4ade80" />)}
            </Section>
          )}

          {decisions.length > 0 && (
            <Section title="Decisions">
              {decisions.map((d, i) => <BulletItem key={i} text={d} accent="#a78bfa" />)}
            </Section>
          )}
        </>
      )}

      {/* Transcript */}
      {segments.length > 0 && (
        <Section title="Transcript">
          {segments.map((seg, i) => {
            const col = speakerColour(seg.speaker);
            return (
              <View key={i} style={[styles.segment, { borderLeftColor: col + '50', backgroundColor: col + '0d' }]}>
                <View style={styles.segmentHeader}>
                  <View style={[styles.speakerDot, { backgroundColor: col }]} />
                  <Text style={[styles.speakerLabel, { color: col }]}>{seg.speaker}</Text>
                  <Text style={styles.timestamp}>{formatTime(seg.start)}</Text>
                </View>
                <Text style={styles.segmentText}>{seg.text}</Text>
              </View>
            );
          })}
        </Section>
      )}

      {rec.transcript && segments.length === 0 && (
        <Section title="Transcript">
          <Text style={styles.body}>{rec.transcript.fullText}</Text>
        </Section>
      )}

      {!rec.transcript && !isQueued && (
        <View style={styles.emptyTranscript}>
          <Text style={styles.emptyText}>No transcript available.</Text>
        </View>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function BulletItem({ text, accent = '#9ca3af' }: { text: string; accent?: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={[styles.bulletDot, { backgroundColor: accent }]} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#030712' },
  content: { padding: 20, paddingBottom: 60, gap: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

  title: { fontSize: 20, fontWeight: '700', color: '#f9fafb', lineHeight: 28 },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#172554', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#1e3a8a',
  },
  bannerText: { flex: 1, color: '#93c5fd', fontSize: 13, lineHeight: 18 },
  bannerFailed: { backgroundColor: '#450a0a', borderColor: '#7f1d1d' },
  bannerFailedText: { color: '#fca5a5', fontSize: 13 },

  section: { gap: 8 },
  sectionTitle: {
    fontSize: 10, fontWeight: '700', letterSpacing: 1.5,
    textTransform: 'uppercase', color: '#6b7280',
  },
  sectionCard: {
    backgroundColor: '#111827', borderRadius: 16,
    borderWidth: 1, borderColor: '#1f2937', padding: 16, gap: 8,
  },
  body: { fontSize: 14, color: '#d1d5db', lineHeight: 22 },
  bulletRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bulletDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  bulletText: { flex: 1, fontSize: 14, color: '#d1d5db', lineHeight: 22 },

  segment: {
    borderLeftWidth: 3, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, gap: 6,
  },
  segmentHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  speakerDot: { width: 6, height: 6, borderRadius: 3 },
  speakerLabel: { fontSize: 11, fontWeight: '700' },
  timestamp: { fontSize: 10, color: '#6b7280', marginLeft: 'auto' },
  segmentText: { fontSize: 13, color: '#d1d5db', lineHeight: 20 },

  emptyTranscript: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#6b7280', fontSize: 14 },
  errorText: { color: '#f87171', textAlign: 'center', marginBottom: 16 },
  backBtn: { padding: 12, backgroundColor: '#111827', borderRadius: 12 },
  backBtnText: { color: '#f97316', fontWeight: '600' },
});
