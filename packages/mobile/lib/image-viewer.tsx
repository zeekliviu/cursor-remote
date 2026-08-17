import { useCallback, useEffect, useRef, useState } from "react";
import {
  Image,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export type ImageViewerImage = {
  uri: string;
  name?: string;
  accessibilityLabel?: string;
};

export type ImageViewerProps = {
  visible: boolean;
  images: readonly ImageViewerImage[];
  initialIndex?: number;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
};

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(Math.round(index), 0), count - 1);
}

/**
 * Dependency-free, full-screen viewer for local or remote image URIs.
 * Images use contain sizing; horizontal swipes page between attachments.
 */
export function ImageViewer({
  visible,
  images,
  initialIndex = 0,
  onClose,
  onIndexChange,
}: ImageViewerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = useState(() =>
    clampIndex(initialIndex, images.length),
  );
  const currentIndexRef = useRef(currentIndex);
  const widthRef = useRef(width);

  const updateIndex = useCallback(
    (nextIndex: number) => {
      const next = clampIndex(nextIndex, images.length);
      if (currentIndexRef.current === next) return;
      currentIndexRef.current = next;
      setCurrentIndex(next);
      onIndexChange?.(next);
    },
    [images.length, onIndexChange],
  );

  const alignToInitialImage = useCallback(() => {
    const next = clampIndex(initialIndex, images.length);
    currentIndexRef.current = next;
    setCurrentIndex(next);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        x: next * widthRef.current,
        y: 0,
        animated: false,
      });
    });
  }, [images.length, initialIndex]);

  useEffect(() => {
    if (!visible) return;
    alignToInitialImage();
  }, [alignToInitialImage, visible]);

  useEffect(() => {
    widthRef.current = width;
    if (!visible) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        x: currentIndexRef.current * width,
        y: 0,
        animated: false,
      });
    });
  }, [visible, width]);

  const onPageSettled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      updateIndex(event.nativeEvent.contentOffset.x / width);
    },
    [updateIndex, width],
  );

  const current = images[currentIndex];

  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onShow={alignToInitialImage}
      onRequestClose={onClose}
    >
      <View
        style={styles.root}
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
      >
        {images.length > 0 ? (
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            bounces={false}
            decelerationRate="fast"
            disableIntervalMomentum
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onPageSettled}
            scrollEventThrottle={16}
            accessibilityLabel="Image gallery"
          >
            {images.map((image, index) => {
              const label =
                image.accessibilityLabel ||
                image.name ||
                `Image ${index + 1} of ${images.length}`;
              return (
                <View
                  key={`${image.uri}-${index}`}
                  style={{ width, height }}
                  importantForAccessibility={
                    index === currentIndex ? "yes" : "no-hide-descendants"
                  }
                >
                  <Image
                    source={{ uri: image.uri }}
                    style={styles.image}
                    resizeMode="contain"
                    accessible
                    accessibilityLabel={label}
                  />
                </View>
              );
            })}
          </ScrollView>
        ) : (
          <View style={[styles.empty, { width, height }]}>
            <Text style={styles.emptyTitle}>Image unavailable</Text>
            <Text style={styles.emptyBody}>There is no image to display.</Text>
          </View>
        )}

        <View
          pointerEvents="none"
          style={[styles.counterWrap, { top: Math.max(insets.top, 12) + 10 }]}
        >
          {images.length > 1 ? (
            <Text
              style={styles.counter}
              accessibilityLiveRegion="polite"
              accessibilityLabel={`Image ${currentIndex + 1} of ${
                images.length
              }`}
            >
              {currentIndex + 1} / {images.length}
            </Text>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close image viewer"
          accessibilityHint="Returns to the chat"
          hitSlop={8}
          onPress={onClose}
          style={({ pressed }) => [
            styles.closeButton,
            { top: Math.max(insets.top, 12) + 4 },
            pressed && styles.closeButtonPressed,
          ]}
        >
          <Text style={styles.closeIcon}>×</Text>
        </Pressable>

        {current?.name ? (
          <View
            pointerEvents="none"
            style={[
              styles.captionWrap,
              { bottom: Math.max(insets.bottom, 12) + 10 },
            ]}
          >
            <Text style={styles.caption} numberOfLines={2}>
              {current.name}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

export default ImageViewer;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#090909" },
  image: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  closeButton: {
    position: "absolute",
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(28, 25, 21, 0.78)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.24)",
  },
  closeButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.94 }],
  },
  closeIcon: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "300",
    lineHeight: 32,
    marginTop: -2,
  },
  counterWrap: {
    position: "absolute",
    left: 72,
    right: 72,
    alignItems: "center",
  },
  counter: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    backgroundColor: "rgba(28, 25, 21, 0.72)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    overflow: "hidden",
  },
  captionWrap: {
    position: "absolute",
    left: 28,
    right: 28,
    alignItems: "center",
  },
  caption: {
    color: "#fff",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    backgroundColor: "rgba(28, 25, 21, 0.72)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    overflow: "hidden",
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 6,
  },
  emptyTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  emptyBody: { color: "#b7b1a8", fontSize: 13 },
});
