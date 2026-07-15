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
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  View,
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

type ScrollToKeyboard = ScrollView['scrollResponderScrollNativeHandleToKeyboard'];

interface KeyboardScrollable {
  scrollResponderScrollNativeHandleToKeyboard: ScrollToKeyboard;
}

export function scrollInputAboveKeyboard(
  scrollView: KeyboardScrollable,
  input: Parameters<ScrollToKeyboard>[0],
  platform: typeof Platform.OS,
) {
  const scroll = () => {
    scrollView.scrollResponderScrollNativeHandleToKeyboard(input, spacing.xl, true);
  };

  if (platform === 'android') {
    return setTimeout(scroll, 200);
  }

  scroll();
}

export function KeyboardAwareFormScreen({
  children,
  contentContainerStyle,
}: KeyboardAwareFormScreenProps) {
  const scrollRef = useRef<ScrollView>(null);
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
    (inputRef: RefObject<View | null>) => {
      const input = inputRef.current;
      const scrollView = scrollRef.current;

      if (!input || !scrollView) {
        return;
      }

      scrollInputAboveKeyboard(scrollView, input, Platform.OS);
    },
    [],
  );

  const scrollInputIntoView = useCallback(
    (inputRef: RefObject<View | null>) => {
      if (keyboardHeight > 0) {
        performScroll(inputRef);
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
      performScroll(pendingInputRef.current);
    }
  }, [keyboardHeight, performScroll]);

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
