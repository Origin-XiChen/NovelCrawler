import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.originxichen.novelcrawler.mobile',
  appName: 'NovelCrawler',
  webDir: '../static/mobile-app-native',
  backgroundColor: '#f5f3ee',
  android: {
    allowMixedContent: true,
    adjustMarginsForEdgeToEdge: 'auto',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
