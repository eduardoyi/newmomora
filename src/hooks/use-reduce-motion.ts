import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** The OS "reduce motion" setting, kept live. False until the (async) first
 * read resolves, so callers should treat it as "animate unless told not to". */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(AccessibilityInfo.isReduceMotionEnabled())
      .then((enabled) => {
        // The state starts false, so only an "on" needs to be recorded (and a
        // no-op set would just schedule a pointless render).
        if (!cancelled && enabled) setReduceMotion(true);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
