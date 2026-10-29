import * as ImagePicker from 'expo-image-picker';

/** Shared by staff and portal mode (no session/sync imports). */
export type RNFile = { uri: string; name: string; type: string };

/** Camera first; falls back to the gallery when camera permission is refused. */
export async function pickImage(source: 'camera' | 'library'): Promise<RNFile | 'denied' | null> {
  if (source === 'camera') {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) return 'denied';
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7 };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const a = r.canceled ? null : r.assets[0];
  if (!a) return null;
  return { uri: a.uri, name: a.fileName ?? `scan-${Date.now()}.jpg`, type: a.mimeType ?? 'image/jpeg' };
}
