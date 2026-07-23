import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cc.anyyu.clauderemote',
  appName: 'Claude Remote',
  webDir: 'web',
  ios: { scrollEnabled: false, contentInset: 'never' },
  plugins: { Keyboard: { resize: 'none' } },
};

export default config;
