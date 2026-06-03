import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/constants/theme';

interface FormScrollContextValue {
  scrollInputIntoView: (inputRef: RefObject<View | null>) => void;
}

const FormScrollContext = createContext<FormScrollContextValue | null>(null);

export function useFormScrollContext() {
  return useContext(FormScrollContext);
}

interface KeyboardAwareFormScreenProps {
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export function KeyboardAwareFormScreen({
  children,
  contentContainerStyle,
}: KeyboardAwareFormScreenProps) {
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const pendingInputRef = useRef<RefObject<View | null> | null>(null);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
      pendingInputRef.current = null;
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const performScroll = useCallback(
    (inputRef: RefObject<View | null>, activeKeyboardHeight: number) => {
      const input = inputRef.current;
      const scrollView = scrollRef.current;

      if (!input || !scrollView || activeKeyboardHeight === 0) {
        return;
      }

      const measure = () => input.measureInWindow((_inputX, inputPageY, _inputWidth, inputHeight) => {
        // Use screen.height — measureInWindow returns absolute screen coordinates, and
        // window.height can shrink on Android (adjustResize) making keyboardTop wrong.
        const screenHeight = Dimensions.get('screen').height;
        const keyboardTop = screenHeight - activeKeyboardHeight;
        const inputBottom = inputPageY + inputHeight;
        const targetBottom = keyboardTop - spacing.lg;

        if (inputBottom <= targetBottom) {
          return;
        }

        const overlap = inputBottom - targetBottom + spacing.md;
        scrollView.scrollTo({
          y: scrollYRef.current + overlap,
          animated: true,
        });
      });

      if (Platform.OS === 'android') {
        setTimeout(measure, 200);
      } else {
        measure();
      }
    },
    [],
  );

  const scrollInputIntoView = useCallback(
    (inputRef: RefObject<View | null>) => {
      if (keyboardHeight > 0) {
        performScroll(inputRef, keyboardHeight);
        return;
      }

      pendingInputRef.current = inputRef;
    },
    [keyboardHeight, performScroll],
  );

  useEffect(() => {
    if (keyboardHeight > 0 && pendingInputRef.current) {
      // Keep pendingInputRef set — Android fires keyboardDidShow multiple times
      // as it animates in. Cleared in keyboardDidHide.
      performScroll(pendingInputRef.current, keyboardHeight);
    }
  }, [keyboardHeight, performScroll]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <FormScrollContext.Provider value={{ scrollInputIntoView }}>
        <ScrollView
          ref={scrollRef}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          contentContainerStyle={[
            styles.content,
            contentContainerStyle,
            keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : null,
          ]}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onScroll={handleScroll}
          scrollEventThrottle={16}
        >
          {children}
        </ScrollView>
      </FormScrollContext.Provider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    flexGrow: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
});
