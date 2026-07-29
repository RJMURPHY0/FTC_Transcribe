// Best-microphone auto-detect, ported from FTC Whisper's recorder ranking
// (recorder.py _auto_rank/_pick_best_input). Name-based, no audio sampling:
// instant, deterministic, safe to run on every stream open.
//
// Lower rank is better. External mics beat the built-in array: plugging in a
// headset must switch to it even when the OS keeps the laptop mic as default.
// Bluetooth hands-free profiles late (they sound terrible), loopback/virtual
// endpoints last (they hear the speakers, not the user).

export type MicDevice = { deviceId: string; label: string };

const VIRTUAL = [
  'stereo mix', 'sound mapper', 'primary sound', 'what u hear', 'wave out',
  'pc speaker', 'loopback', 'virtual', 'cable', 'eshare', 'teams audio',
  'zoom audio', 'voicemeeter', 'vb-audio', 'obs', 'ndi',
  // Localised Windows loopback endpoints
  'stereomix', 'mixage', 'mezcla', 'missaggio', 'микшер', 'ミキサー',
];
const BT_HANDSFREE = ['bluetooth', 'hands-free', 'hfp', ' ag audio'];
const DEDICATED = [
  'headset', 'usb audio', 'usb mic', 'webcam', 'logi', 'jabra', 'yeti',
  'rode', 'shure', 'blue ', 'elgato', 'samson', 'snowball', 'at2020',
  'fifine', 'hyperx', 'steelseries', 'airpods', 'earpods',
];
const BUILT_IN = ['microphone', 'mic', 'array'];

export function rankMic(label: string): number {
  const n = (label || '').toLowerCase();
  if (VIRTUAL.some(v => n.includes(v))) return 4;
  if (BT_HANDSFREE.some(b => n.includes(b))) return 3;
  if (DEDICATED.some(s => n.includes(s))) return 0;
  if (BUILT_IN.some(s => n.includes(s))) return 1;
  return 2;
}

// Chrome on Windows exposes pseudo entries whose deviceId is 'default' /
// 'communications' duplicating a real device. Rank only real devices; use the
// 'default' pseudo label (minus its prefix) to break ties, mirroring
// Whisper's OS-default tie-break.
export function pickBestMic(devices: MicDevice[]): MicDevice | null {
  const real = devices.filter(
    d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'
  );
  if (!real.length) return null;
  const defaultEntry = devices.find(d => d.deviceId === 'default');
  const defaultLabel = (defaultEntry?.label || '')
    .replace(/^default\s*-\s*/i, '')
    .trim()
    .toLowerCase();
  const bestRank = Math.min(...real.map(d => rankMic(d.label)));
  const best = real.filter(d => rankMic(d.label) === bestRank);
  if (defaultLabel) {
    const osDefault = best.find(
      d => d.label.trim().toLowerCase() === defaultLabel
    );
    if (osDefault) return osDefault;
  }
  return best[0];
}

export async function listMics(): Promise<MicDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(d => d.kind === 'audioinput')
    .map(d => ({ deviceId: d.deviceId, label: d.label }));
}

// Stored preference semantics: missing or 'auto' → auto-detect best mic;
// 'system' → browser/OS default; anything else → explicit deviceId.
export async function getAudioConstraint(): Promise<MediaTrackConstraints | boolean> {
  let preferred: string | null = null;
  try {
    preferred = localStorage.getItem('preferredMicId');
  } catch {}
  if (preferred === 'system') return true;
  if (preferred && preferred !== 'auto') return { deviceId: { ideal: preferred } };
  try {
    const best = pickBestMic(await listMics());
    // Labels are empty until mic permission has been granted once; ranking
    // is meaningless then, so fall back to the default device.
    if (best && best.label) return { deviceId: { ideal: best.deviceId } };
  } catch {}
  return true;
}
