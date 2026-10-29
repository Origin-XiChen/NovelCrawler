import { useEffect, useState } from 'react';
import { gradientFor, initialOf } from '../lib/format';
import { localCoverUrl } from '../lib/offline/reading';
import type { LocalBook } from '../lib/offline/db';

/**
 * 本地书封面:离线包里的封面图(EPUB 声明的 cover / 漫画第一页),
 * 取不到就退回书名首字渐变,保证书架永不留白。
 */
export default function BookCover({ book }: { book: LocalBook }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl('');
    setFailed(false);
    setLoaded(false);
    if (!book.coverArc) return undefined;
    localCoverUrl(book)
      .then((value) => {
        if (alive) setUrl(value);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [book.id, book.coverArc, book.importedAt]);

  const comic = book.kind === 'comic';
  const showImage = url && !failed;
  if (comic) {
    return (
      <div className="comic-cover" style={showImage ? undefined : { background: gradientFor(book.title) }}>
        {showImage ? (
          <img
            src={url}
            alt=""
            loading="lazy"
            className={loaded ? 'is-loaded' : ''}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <span>{initialOf(book.title)}</span>
        )}
      </div>
    );
  }
  return (
    <div className="novel-cover" style={showImage ? undefined : { background: gradientFor(book.title) }}>
      {showImage ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className={loaded ? 'is-loaded' : ''}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <>
          <span className="novel-cover__char">{initialOf(book.title)}</span>
          <span className="novel-cover__format">{book.format === 'epub' ? 'EPUB' : 'TXT'}</span>
        </>
      )}
    </div>
  );
}
