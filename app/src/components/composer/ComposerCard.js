import { View } from 'react-native';
import { GlassSurface } from '../GlassSurface.js';
import { useTheme } from '../../theme.js';

// Keep the glass surface opaque; controls own their disabled appearance.
export function ComposerCard({ children, style }) {
  const { radius } = useTheme();
  return (
    <GlassSurface
      style={{
        borderRadius: radius.island,
        paddingHorizontal: 12,
        paddingTop: 14,
        paddingBottom: 10,
        ...style,
      }}
    >
      <View style={{ gap: 8 }}>{children}</View>
    </GlassSurface>
  );
}
