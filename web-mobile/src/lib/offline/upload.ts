/**
 * 手机本地导入的书回传电脑。
 * 电脑点「同步手机本地」后留下请求标记,手机联网时把原始 EPUB/TXT 传到暂存区,
 * 电脑确认后才收进书库,所以手机只管上传,不直接改电脑的下载目录。
 */
import { apiGet, apiPost, apiUpload } from '../api';
import { getActiveServer } from '../connection';
import { allBooks, loadSource, putBook, type LocalBook } from './db';
import { announceLibraryChange } from './useLibrary';

interface PendingState {
  ok: boolean;
  requested: boolean;
  requested_at?: number;
  done_at?: number;
}

export interface UploadSummary {
  requested: boolean;
  uploaded: LocalBook[];
  failed: number;
}

let running = false;

export async function syncImportedBooks(): Promise<UploadSummary> {
  if (running || !getActiveServer()) return { requested: false, uploaded: [], failed: 0 };
  running = true;
  try {
    let pending: PendingState;
    try {
      pending = await apiGet<PendingState>('/api/mobile/sync/pending');
    } catch {
      return { requested: false, uploaded: [], failed: 0 };
    }
    if (!pending.requested) return { requested: false, uploaded: [], failed: 0 };

    const books = (await allBooks()).filter(
      (book) => book.origin === 'import' && book.syncState === 'pending',
    );
    const uploaded: LocalBook[] = [];
    let failed = 0;
    for (const book of books) {
      const source = await loadSource(book.id);
      if (!source) {
        failed += 1;
        continue;
      }
      try {
        await apiUpload<{ ok: boolean }>('/api/mobile/sync/upload', source, {
          name: book.file,
        });
        const next: LocalBook = { ...book, syncState: 'done' };
        await putBook(next);
        uploaded.push(next);
      } catch {
        failed += 1;
      }
    }

    // 有文件没传成就不回执,电脑端继续显示"等待手机上传",下一轮再试
    if (!failed) {
      try {
        await apiPost('/api/mobile/sync/ack', { uploaded: uploaded.length });
      } catch {
        // 文件已经在暂存区,回执失败不影响桌面端看到列表
      }
    }
    if (uploaded.length) announceLibraryChange();
    return { requested: true, uploaded, failed };
  } finally {
    running = false;
  }
}
