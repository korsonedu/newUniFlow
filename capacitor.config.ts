import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.uniflow.timeline',
  appName: 'UniFlow',
  webDir: 'dist',
  server: {
    cleartext: true,
    androidScheme: 'https',
  },
};

export default config;
