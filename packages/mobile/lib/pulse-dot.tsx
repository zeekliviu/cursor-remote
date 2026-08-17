import { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { useReducedMotion } from "./reduced-motion";

/** Slow amber breath — "something is happening" without shouting. */
export function PulseDot({ size = 7 }: { size?: number }) {
  const pulse = useRef(new Animated.Value(0.35)).current;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 720,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 720,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reducedMotion]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { width: size, height: size, borderRadius: size / 2, opacity: pulse },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { backgroundColor: "#b8863b" },
});
