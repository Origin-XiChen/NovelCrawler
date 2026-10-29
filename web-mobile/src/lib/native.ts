import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

export const IS_NATIVE = Capacitor.isNativePlatform();

const RELEASE_API = 'https://api.github.com/repos/Origin-XiChen/NovelCrawler/releases/latest';
/** Dev 通道:列全部 release,允许预发布(prerelease)版本 */
const RELEASES_API = 'https://api.github.com/repos/Origin-XiChen/NovelCrawler/releases?per_page=20';
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
  prerelease?: boolean;
  draft?: boolean;
  assets?: ReleaseAsset[];
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * 语义化版本比较,支持 `1.7.9-dev.2` 这类预发布后缀:
 *   1.7.9-dev.1 < 1.7.9-dev.2 < 1.7.9
 * Dev 版靠这个后缀递增,正式版号(1.7.9)不被占用 —— 转正后所有 Dev 用户都能升上去。
 */
function prereleaseParts(version: string): { name: string; num: number } | null {
  const match = version.replace(/^v/i, '').match(/[-+]([a-z]*)\.?(\d*)$/i);
  if (!match) return null;
  return { name: (match[1] || '').toLowerCase(), num: Number.parseInt(match[2] || '0', 10) || 0 };
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  const pa = prereleaseParts(a);
  const pb = prereleaseParts(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;    // 正式版 > 预发布
  if (!pb) return -1;
  if (pa.name !== pb.name) return pa.name < pb.name ? -1 : 1;
  return pa.num - pb.num;
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

/**
 * 查最新 APK。
 * includePrerelease=true 时走 Dev 通道:列出全部 release 并允许预发布版本,
 * 取第一个「带 Mobile APK」的版本 —— 这样 Dev 版也能推给手机测试。
 */
export async function fetchLatestApk(includePrerelease = false): Promise<ApkUpdate | null> {
  if (!IS_NATIVE) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const url = includePrerelease ? RELEASES_API : RELEASE_API;
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`更新接口返回 ${res.status}`);
    const payload = (await res.json()) as ReleaseInfo | ReleaseInfo[];
    const list = (Array.isArray(payload) ? payload : [payload])
      .filter((item) => item && !item.draft)
      .filter((item) => includePrerelease || !item.prerelease);
    const release = list.find((item) =>
      (item.assets || []).some((asset) => APK_PATTERN.test(asset.name || '') && /mobile/i.test(asset.name || '')),
    ) || list[0];
    if (!release) return null;
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
    // 死循环防线:release 的 tag 与包内实际版本必须一致。
    // 如果 tag 是 dev.5 但挂的仍是 dev.4 的 APK,用户会"装完还提示更新",
    // 一路循环下去 —— 这种情况宁可先不提示,也不要发一个装不掉的包。
    const assetVersion = (asset.name || '').match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.apk$/i)?.[1] || '';
    if (assetVersion && compareVersions(assetVersion, version) !== 0) {
      console.warn('[update] 安装包版本与发布不一致,已跳过', { tag: version, asset: assetVersion });
      return null;
    }
    return { version, url: asset.browser_download_url, notes: release.body };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function openApkDownload(url: string): Promise<void> {
  await Browser.open({ url });
}
