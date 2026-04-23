import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable,
  StyleSheet, Text, View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { deleteRecording, getRecordings, Recording } from '../src/api';

function statusColour(status: string) {
  if (status === 'completed')  return { bg: '#052e16', text: '#4ade80' };
  if (status === 'failed')     return { bg: '#450a0a', text: '#f87171' };
  if (status === 'uploading' || status === 'queued') return { bg: '#172554', text: '#60a5fa' };
  return { bg: '#1c1002', text: '#fbbf24' };
}

function statusLabel(status: string) {
  if (status === 'processing') return 'analysing';
  if (status === 'uploading' || status === 'queued') return 'queued';
  return status;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function safeJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function RecordingCard({ item, onDelete }: { item: Recording; onDelete: (id: string) => void }) {
  const col = statusColour(item.status);
  const actions = safeJson<string[]>(item.summary?.actionItems, []);
  const points  = safeJson<string[]>(item.summary?.keyPoints,   []);

  const confirmDelete = () => {
    Alert.alert('Delete recording?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete(item.id) },
    ]);
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => router.push(`/recording/${item.id}`)}
    >
      <View style={styles.cardRow}>
        <View style={styles.cardMeta}>
          <Text style={styles.cardTitle} numberOfLines={1}>{item.title || 'Untitled'}</Text>
          <Text style={styles.cardDate}>{formatDate(item.createdAt)}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: col.bg }]}>
          <Text style={[styles.badgeText, { color: col.text }]}>{statusLabel(item.status)}</Text>
        </View>
      </View>

      {item.summary?.overview ? (
        <Text style={styles.overview} numberOfLines={2}>{item.summary.overview}</Text>
      ) : null}

      {(actions.length > 0 || points.length > 0) && (
        <View style={styles.chips}>
          {actions.length > 0 && (
            <Text style={styles.chip}>✓ {actions.length} action{actions.length !== 1 ? 's' : ''}</Text>
          )}
          {points.length > 0 && (
            <Text style={styles.chip}>⚡ {points.length} key point{points.length !== 1 ? 's' : ''}</Text>
          )}
        </View>
      )}

      <Pressable style={styles.deleteBtn} onPress={confirmDelete} hitSlop={8}>
        <Text style={styles.deleteBtnText}>Delete</Text>
      </Pressable>
    </Pressable>
  );
}

export default function HomeScreen() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await getRecordings();
      setRecordings(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const handleDelete = async (id: string) => {
    await deleteRecording(id);
    setRecordings((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>FTC Transcribe</Text>
        <Pressable
          style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
          onPress={() => router.push('/record')}
        >
          <Text style={styles.newBtnText}>⏺  New Recording</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#f97316" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : recordings.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No recordings yet</Text>
          <Text style={styles.emptyBody}>Tap "New Recording" to get started</Text>
          <Pressable
            style={[styles.newBtn, { marginTop: 20 }]}
            onPress={() => router.push('/record')}
          >
            <Text style={styles.newBtnText}>Start Recording</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={recordings}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <RecordingCard item={item} onDelete={handleDelete} />
          )}
          contentContainerStyle={styles.list}
          onRefresh={load}
          refreshing={loading}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#030712' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 60, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: '#1f2937',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#f9fafb' },
  newBtn: {
    backgroundColor: '#f97316', paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 12,
  },
  newBtnPressed: { opacity: 0.8 },
  newBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  list: { padding: 16, gap: 12 },
  card: {
    backgroundColor: '#111827', borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: '#1f2937', gap: 8,
  },
  cardPressed: { opacity: 0.85 },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardMeta: { flex: 1 },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#f9fafb' },
  cardDate: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  overview: { fontSize: 13, color: '#9ca3af', lineHeight: 20 },
  chips: { flexDirection: 'row', gap: 12 },
  chip: { fontSize: 11, color: '#6b7280' },
  deleteBtn: { alignSelf: 'flex-end', marginTop: 4 },
  deleteBtnText: { fontSize: 12, color: '#ef4444' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: '#f87171', textAlign: 'center', marginBottom: 12 },
  retryBtn: { padding: 12 },
  retryText: { color: '#f97316', fontWeight: '600' },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#f9fafb', marginBottom: 8 },
  emptyBody: { fontSize: 14, color: '#6b7280', textAlign: 'center' },
});
