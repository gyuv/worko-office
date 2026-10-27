import { Feather } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import type { Theme } from '../theme';
import { t, ui } from '../ui';

export function Header({ theme, title, onBack, right }: { theme: Theme; title: string; onBack?: () => void; right?: React.ReactNode }) {
  const s = ui(theme);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
      {onBack && <Pressable style={s.icon} onPress={onBack} accessibilityRole="button" accessibilityLabel={t('m.client.back')}>
        <Feather name="arrow-left" size={22} color={theme.text} />
      </Pressable>}
      <Text style={[s.h1, { flex: 1 }]} numberOfLines={2} accessibilityRole="header">{title}</Text>
      {right}
    </View>
  );
}
