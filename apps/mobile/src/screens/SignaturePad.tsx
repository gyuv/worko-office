import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { hasInk, strokesToPaths, type Pt } from '../logic/signature';
import type { Theme } from '../theme';
import { t, ui } from '../ui';

/** Finger signature on an SVG canvas; saved as a PNG file uri via view-shot. White background so it prints. */
export function SignaturePad({ theme, onSave, onCancel }: { theme: Theme; onSave(uri: string): void; onCancel(): void }) {
  const s = ui(theme);
  const ref = useRef<View>(null);
  const [strokes, setStrokes] = useState<Pt[][]>([]);
  const [error, setError] = useState(false);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { const { locationX: x, locationY: y } = e.nativeEvent; setStrokes((p) => [...p, [{ x, y }]]); },
    onPanResponderMove: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      setStrokes((p) => (p.length ? [...p.slice(0, -1), [...p[p.length - 1]!, { x, y }]] : p));
    },
  }), []);
  const paths = strokesToPaths(strokes);

  async function save() {
    if (!hasInk(strokes)) { setError(true); return; }
    const uri = await captureRef(ref, { format: 'png', quality: 1, result: 'tmpfile' });
    onSave(uri);
  }

  return (
    <View>
      <Text style={s.h2}>{t('m.sig.title')}</Text>
      {error && <Text accessibilityRole="alert" style={s.alert}>{t('m.sig.empty')}</Text>}
      <View ref={ref} collapsable={false} accessible accessibilityLabel={t('m.sig.pad')}
        style={{ height: 220, backgroundColor: '#ffffff', borderRadius: 6, borderWidth: 1, borderColor: theme.border }} {...pan.panHandlers}>
        <Svg width="100%" height="100%">
          {paths.map((d, i) => <Path key={i} d={d} stroke="#111111" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
        </Svg>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Pressable style={s.ghost} onPress={() => { setStrokes([]); setError(false); }} accessibilityRole="button"><Text style={s.ghostText}>{t('m.sig.clear')}</Text></Pressable>
        <Pressable style={s.ghost} onPress={onCancel} accessibilityRole="button"><Text style={s.ghostText}>{t('common.cancel')}</Text></Pressable>
        <Pressable style={[s.button, { flex: 1, marginTop: 0 }]} onPress={() => void save()} accessibilityRole="button"><Text style={s.buttonText}>{t('m.sig.save')}</Text></Pressable>
      </View>
    </View>
  );
}
