import { Feather } from '@expo/vector-icons';
import { pickUpdate, RELEASES_API, type GhRelease, type UpdateInfo } from '@worko/domain';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { alpha, type Theme } from '../theme';
import { t, ui } from '../ui';

export const appVersion = () => Constants.expoConfig?.version ?? '0.0.0';

/** Looks for a newer Android build on GitHub Releases; resolves null when up to date, offline or not Android. */
export async function findAndroidUpdate(fetcher: typeof fetch = fetch, current = appVersion()): Promise<UpdateInfo | null> {
  try {
    const r = await fetcher(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    return pickUpdate((await r.json()) as GhRelease[], 'android', current);
  } catch { return null; }
}

/** Checked at every app start: a calm sheet offering the new APK (Android installs it after the download). */
export function UpdatePrompt({ theme }: { theme: Theme }) {
  const s = ui(theme);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android' || __DEV__) return;
    let live = true;
    void findAndroidUpdate().then((u) => { if (live) setInfo(u); });
    return () => { live = false; };
  }, []);
  if (!info) return null;
  const notes = info.notes.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6).join('\n');
  return (
    <Modal transparent animationType="fade" onRequestClose={() => setInfo(null)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }}>
        <View style={{ backgroundColor: theme.bg, borderRadius: 24, padding: 20, borderWidth: 1, borderColor: theme.glassBorder }}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: alpha(theme.primary, 0.15), alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}>
            <Feather name="download-cloud" size={24} color={theme.primary} />
          </View>
          <Text style={[s.h1, { textAlign: 'center', marginTop: 12 }]}>{t('update.ready', { version: info.version })}</Text>
          <Text style={[s.muted, { textAlign: 'center', marginTop: 4 }]}>{t('update.version', { version: appVersion() })} → {info.version}</Text>
          {!!notes && <ScrollView style={{ maxHeight: 140, marginTop: 12 }}><Text style={s.muted}>{notes}</Text></ScrollView>}
          <Pressable style={s.button} accessibilityRole="button" onPress={() => { void Linking.openURL(info.url); setInfo(null); }}>
            <Text style={s.buttonText}>{t('update.restart')}</Text>
          </Pressable>
          <Pressable style={{ minHeight: 44, justifyContent: 'center', marginTop: 4 }} accessibilityRole="button" onPress={() => setInfo(null)}>
            <Text style={{ color: theme.textMuted, textAlign: 'center' }}>{t('update.later')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
