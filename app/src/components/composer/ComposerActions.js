import { useWindowDimensions, View } from 'react-native';

const row = { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 };

export function ComposerActions({ attachment, model, mode, action }) {
  const { width, fontScale } = useWindowDimensions();
  if (width < 360 || fontScale > 1.3) {
    return <View style={{ gap: 4 }}>
      <View style={row}>{model}{mode}</View>
      <View style={row}>{attachment}<View style={{ flex: 1 }} />{action}</View>
    </View>;
  }
  return <View style={row}>{attachment}{model}{mode}<View style={{ flex: 1 }} />{action}</View>;
}
