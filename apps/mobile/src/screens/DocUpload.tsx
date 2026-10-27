import type { MessageKey } from '@worko/i18n';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, TextInput, View } from 'react-native';
import { currentFy } from '../logic/registers';
import { pickImage, uploadDocument } from '../net';
import { syncNow, useSync } from '../sync';
import type { Theme } from '../theme';
import { t, ui } from '../ui';
import { Header } from './Header';

export const DOC_CATEGORIES = ['kyc', 'itr', 'gst', 'tds', 'audit', 'roc', 'notice', 'other'] as const;
const FY_RE = /^\d{4}-\d{2}$/;

/** Scan (camera) or pick a photo and upload. Upload needs a connection; bytes are never synced. */
export function DocUpload({ theme, clientId, onBack }: { theme: Theme; clientId: string; onBack?: () => void }) {
  const s = ui(theme);
  const online = useSync((x) => x.online);
  const [file, setFile] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [category, setCategory] = useState<(typeof DOC_CATEGORIES)[number]>('kyc');
  const [fy, setFy] = useState(currentFy());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function pick(src: 'camera' | 'library') {
    setMsg(null);
    const r = await pickImage(src);
    if (r === 'denied') { setMsg(t('m.doc.noPermission')); const lib = await pickImage('library'); if (lib && lib !== 'denied') { setFile(lib); setName(lib.name); } return; }
    if (r) { setFile(r); setName(r.name); }
  }
  async function upload() {
    if (!file) return;
    if (!online) { setMsg(t('m.doc.offline')); return; }
    setBusy(true); setMsg(null);
    try {
      await uploadDocument(file, { clientId, category: t(`m.doc.cat.${category}` as MessageKey), fy, name: name.trim() || undefined });
      setMsg(t('m.doc.uploaded')); setFile(null); void syncNow();
    } catch (e) { setMsg(t('m.doc.uploadFailed', { reason: (e as Error).message })); }
    finally { setBusy(false); }
  }

  return (
    <View>
      <Header theme={theme} title={t('m.client.scan')} onBack={onBack} />
      {!online && <Text accessibilityRole="alert" style={s.alert}>{t('m.doc.offline')}</Text>}
      {msg && <Text accessibilityRole="alert" style={s.alert}>{msg}</Text>}
      {!file ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Pressable style={[s.button, { flex: 1 }]} onPress={() => void pick('camera')} accessibilityRole="button"><Text style={s.buttonText}>{t('m.doc.camera')}</Text></Pressable>
          <Pressable style={[s.button, { flex: 1 }]} onPress={() => void pick('library')} accessibilityRole="button"><Text style={s.buttonText}>{t('m.doc.library')}</Text></Pressable>
        </View>
      ) : (
        <View>
          <Image source={{ uri: file.uri }} style={{ width: '100%', height: 240, resizeMode: 'contain', marginTop: 12, backgroundColor: theme.surfaceAlt }} accessibilityIgnoresInvertColors />
          <Pressable style={[s.ghost, { marginTop: 8, alignSelf: 'flex-start' }]} onPress={() => setFile(null)} accessibilityRole="button"><Text style={s.ghostText}>{t('m.doc.retake')}</Text></Pressable>
          <Text style={s.label}>{t('m.doc.name')}</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} accessibilityLabel={t('m.doc.name')} />
          <Text style={s.label}>{t('m.doc.category')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {DOC_CATEGORIES.map((c) => (
              <Pressable key={c} onPress={() => setCategory(c)} style={[s.chipBtn, category === c && { backgroundColor: theme.primary, borderColor: theme.primary }]}
                accessibilityRole="radio" accessibilityState={{ checked: category === c }}>
                <Text style={{ color: category === c ? theme.primaryText : theme.text }}>{t(`m.doc.cat.${c}` as MessageKey)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.label}>{t('m.doc.fy')}</Text>
          <TextInput style={s.input} value={fy} onChangeText={setFy} placeholder="2026-27" placeholderTextColor={theme.textMuted} accessibilityLabel={t('m.doc.fy')} />
          <Pressable style={[s.button, (busy || !online || !FY_RE.test(fy)) && { opacity: 0.5 }]} disabled={busy || !FY_RE.test(fy)} onPress={() => void upload()} accessibilityRole="button">
            {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={s.buttonText}>{t('m.doc.upload')}</Text>}
          </Pressable>
        </View>
      )}
    </View>
  );
}
