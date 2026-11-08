import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import { alpha, type Theme } from './theme';

/** True when the user asked the OS to reduce motion (then nothing animates). */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/** One soft colour circle drifting back and forth (transform only, native driver). */
function Blob({ color, size, x, y, dx, dy, ms, still }: { color: string; size: number; x: number; y: number; dx: number; dy: number; ms: number; still: boolean }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v, ms, still]);
  const transform = [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) }, { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) }];
  return <Animated.View style={{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: size / 2, backgroundColor: color, transform }} />;
}

/** Moving colour field behind the whole app; translucent `theme.glass` surfaces sit on top of it. */
export function GlassBackdrop({ theme }: { theme: Theme }) {
  const still = useReduceMotion();
  const a = theme.name === 'dark' ? 0.22 : 0.3;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden', backgroundColor: theme.bg }]}>
      <Blob still={still} color={alpha('#22a35a', a)} size={340} x={-120} y={-80} dx={60} dy={40} ms={9000} />
      <Blob still={still} color={alpha('#14b8a6', a)} size={300} x={180} y={120} dx={-50} dy={60} ms={11000} />
      <Blob still={still} color={alpha('#a3e635', a * 0.8)} size={360} x={-60} y={460} dx={70} dy={-50} ms={13000} />
    </View>
  );
}

/** Fades + slides its content in when mounted (give it a `key` to replay on navigation). */
export function FadeIn({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const still = useReduceMotion();
  const v = useRef(new Animated.Value(still ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: still ? 0 : 320, delay: still ? 0 : delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [v, still, delay]);
  return <Animated.View style={{ flex: 1, opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>{children}</Animated.View>;
}
