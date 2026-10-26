import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

export const IS_NATIVE = Capacitor.isNativePlatform();

const RELEASE_API = 'https://api.github.com/repos/Origin-XiChen/NovelCrawler/releases/latest';
const APK_PATTERN = /\.apk$/i;

export interface ApkUpdate {
  version: string;
  url: string;
  notes?: string;
}

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface ReleaseInfo {
  tag_name?: string;
  body?: string;
  assets?: ReleaseAsset[];
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function currentAppVersion(): Promise<string> {
  if (!IS_NATIVE) return __APP_VERSION__;
  try {
    const info = await App.getInfo();
    return info.version || __APP_VERSION__;
  } catch {
    return __APP_VERSION__;
  }
}

export async function fetchLatestApk(): Promise<ApkUpdate | null> {
  if (!IS_NATIVE) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`更新接口返回 ${res.status}`);
    const release = (await res.json()) as ReleaseInfo;
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!version) return null;
    const local = await currentAppVersion();
    if (compareVersions(version, local) <= 0) return null;
    const asset = (release.assets || []).find(
      (item) => APK_PATTERN.test(item.name || '') && /mobile/i.test(item.name || ''),
    );
    if (!asset?.browser_download_url) {
      throw new Error('最新版本尚未提供 Android 安装包');
    }
    return { version, url: asset.browser_download_url, notes: release.body };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function openApkDownload(url: string): Promise<void> {
  await Browser.open({ url });
}
