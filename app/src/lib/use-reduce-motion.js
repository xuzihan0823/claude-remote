import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// null until the platform answers, so entrance animations wait instead of
// briefly playing for users who have Reduce Motion enabled.
export function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState(null);

  useEffect(() => {
    let active = true;
    const apply = (value) => { if (active) setReduceMotion(Boolean(value)); };

    if (typeof AccessibilityInfo?.isReduceMotionEnabled === 'function') {
      AccessibilityInfo.isReduceMotionEnabled().then(apply).catch(() => apply(false));
    } else {
      apply(false);
    }

    const subscription = typeof AccessibilityInfo?.addEventListener === 'function'
      ? AccessibilityInfo.addEventListener('reduceMotionChanged', apply)
      : null;

    return () => {
      active = false;
      subscription?.remove?.();
    };
  }, []);

  return reduceMotion;
}
