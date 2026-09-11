(() => {
  'use strict';

  const DB_NAME = 'shioriyomi-db';
  const DB_VERSION = 2;
  const STORE_BOOKS = 'books';
  const STORE_META = 'meta';
  const STORE_BOOKMARKS = 'bookmarks';

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'), reader: $('reader'), content: $('content'), emptyState: $('emptyState'), bottomBar: $('bottomBar'),
    bookTitle: $('bookTitle'), progressText: $('progressText'), progressFill: $('progressFill'),
    libraryBtn: $('libraryBtn'), settingsBtn: $('settingsBtn'), bookmarkBtn: $('bookmarkBtn'),
    libraryPanel: $('libraryPanel'), settingsPanel: $('settingsPanel'), tocPanel: $('tocPanel'), backdrop: $('backdrop'),
    openFileBtn: $('openFileBtn'), openFileHero: $('openFileHero'), fileInput: $('fileInput'), loadSampleBtn: $('loadSampleBtn'),
    bookList: $('bookList'), tocList: $('tocList'), bookmarkList: $('bookmarkList'), addBookmarkInPanel: $('addBookmarkInPanel'),
    horizontalBtn: $('horizontalBtn'), verticalBtn: $('verticalBtn'), modeBtn: $('modeBtn'), tocBtn: $('tocBtn'),
    fontSizeRange: $('fontSizeRange'), lineHeightRange: $('lineHeightRange'), paddingRange: $('paddingRange'), themeSelect: $('themeSelect'), tapToggle: $('tapToggle'),
    fontSizeValue: $('fontSizeValue'), lineHeightValue: $('lineHeightValue'), paddingValue: $('paddingValue'),
    prevBookmarkBtn: $('prevBookmarkBtn'), nextBookmarkBtn: $('nextBookmarkBtn'),
    bookMetaDialog: $('bookMetaDialog'), bookMetaDialogTitle: $('bookMetaDialogTitle'), metaFilename: $('metaFilename'),
    metaWork: $('metaWork'), metaSection: $('metaSection'), metaEpisode: $('metaEpisode'), metaOrder: $('metaOrder'),
    workSuggestions: $('workSuggestions'), sectionSuggestions: $('sectionSuggestions'), saveBookMeta: $('saveBookMeta'), cancelBookMeta: $('cancelBookMeta'),
    bookmarkDialog: $('bookmarkDialog'), bookmarkExcerpt: $('bookmarkExcerpt'), bookmarkNote: $('bookmarkNote'), saveBookmark: $('saveBookmark'), cancelBookmark: $('cancelBookmark'),
    toast: $('toast')
  };

  let db;
  let currentBook = null;
  let paragraphs = [];
  let currentIndex = 0;
  let currentBookmarks = [];
  let saveTimer = null;
  let scrollRaf = null;
  let toastTimer = null;
  let pendingBookEdit = null;
  let pendingImport = null;

  const defaultSettings = { mode: 'horizontal', fontSize: 18, lineHeight: 1.8, padding: 28, theme: 'paper', tapToggle: true };
  let settings = { ...defaultSettings };

  function normalizeText(text) {
    return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  }

  function stripExtension(filename = '') {
    return filename.replace(/\.txt$/i, '').trim();
  }

  function safeText(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
  }

  function parseLeadingOrder(value = '') {
    const match = String(value).match(/^\s*(\d{1,5})(?:[\s_\-.]|$)/);
    if (match) return Number(match[1]);
    const story = String(value).match(/第\s*(\d{1,5})\s*[話章節期巻部]/);
    return story ? Number(story[1]) : 999999;
  }

  function guessMetadata(filename, text = '') {
    const base = stripExtension(filename);
    const order = parseLeadingOrder(base);
    let cleaned = base.replace(/^\s*\d{1,5}[\s_\-.]*/, '');
    const parts = cleaned.split(/[_｜|]+/).map(s => s.trim()).filter(Boolean);
    let workTitle = '未分類';
    let sectionTitle = '本編';
    let episodeTitle = cleaned || detectTitle(text, filename);

    if (parts.length >= 2) {
      workTitle = parts[0];
      const sectionIndex = parts.findIndex((p, i) => i > 0 && /^(第?.{0,8}(?:期|部|巻)|.+編)$/.test(p));
      if (sectionIndex > 0) {
        sectionTitle = parts[sectionIndex];
        episodeTitle = parts.filter((_, i) => i !== 0 && i !== sectionIndex).join(' ') || parts[sectionIndex];
      } else {
        episodeTitle = parts.slice(1).join(' ');
      }
    }

    return {
      workTitle: safeText(workTitle, '未分類'),
      sectionTitle: safeText(sectionTitle, '本編'),
      episodeTitle: safeText(episodeTitle, detectTitle(text, filename)),
      episodeOrder: Number.isFinite(order) ? order : 999999
    };
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const database = req.result;
        let booksStore;
        if (!database.objectStoreNames.contains(STORE_BOOKS)) {
          booksStore = database.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
        } else {
          booksStore = event.target.transaction.objectStore(STORE_BOOKS);
        }
        if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META, { keyPath: 'key' });
        if (!database.objectStoreNames.contains(STORE_BOOKMARKS)) {
          const store = database.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
          store.createIndex('bookId', 'bookId', { unique: false });
        }

        if (event.oldVersion < 2 && booksStore) {
          booksStore.openCursor().onsuccess = (cursorEvent) => {
            const cursor = cursorEvent.target.result;
            if (!cursor) return;
            const book = cursor.value;
            const guessed = guessMetadata(book.filename || book.title || 'text.txt', book.text || '');
            cursor.update({
              ...book,
              workTitle: book.workTitle || guessed.workTitle,
              sectionTitle: book.sectionTitle || guessed.sectionTitle,
              episodeTitle: book.episodeTitle || guessed.episodeTitle || book.title || '無題',
              episodeOrder: Number.isFinite(book.episodeOrder) ? book.episodeOrder : guessed.episodeOrder
            });
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
  function reqPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const getMeta = async (key) => (await reqPromise(tx(STORE_META).get(key)))?.value;
  const setMeta = async (key, value) => reqPromise(tx(STORE_META, 'readwrite').put({ key, value }));
  const getAllBooks = async () => reqPromise(tx(STORE_BOOKS).getAll());
  const saveBook = async (book) => reqPromise(tx(STORE_BOOKS, 'readwrite').put(book));
  const getBook = async (id) => reqPromise(tx(STORE_BOOKS).get(id));
  const deleteBookDb = async (id) => reqPromise(tx(STORE_BOOKS, 'readwrite').delete(id));

  async function bookmarksFor(bookId) {
    return new Promise((resolve, reject) => {
      const store = tx(STORE_BOOKMARKS);
      const index = store.index('bookId');
      const req = index.getAll(IDBKeyRange.only(bookId));
      req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.paragraphIndex - b.paragraphIndex));
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteBookmarksForBook(bookId) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_BOOKMARKS, 'readwrite');
      const store = transaction.objectStore(STORE_BOOKMARKS);
      const index = store.index('bookId');
      const range = IDBKeyRange.only(bookId);
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  const putBookmark = async (bm) => reqPromise(tx(STORE_BOOKMARKS, 'readwrite').put(bm));
  const deleteBookmarkDb = async (id) => reqPromise(tx(STORE_BOOKMARKS, 'readwrite').delete(id));

  function splitParagraphs(text) {
    const lines = normalizeText(text).split('\n');
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      out.push({ text: line, heading: isHeading(trimmed) });
    }
    return out;
  }

  function isHeading(s) {
    if (s.length > 34) return false;
    return /^(第[〇一二三四五六七八九十百0-9]+[話章節]|序章|終章|プロローグ|エピローグ|幕間|【.+】|［.+］)/.test(s)
      || (!/[。！？!?」』]$/.test(s) && s.length <= 18 && !s.startsWith('「') && !s.startsWith('『'));
  }

  function detectTitle(text, filename) {
    const lines = normalizeText(text).split('\n').map(s => s.trim()).filter(Boolean);
    return lines[0]?.slice(0, 80) || stripExtension(filename) || '無題';
  }

  async function hashText(text) {
    const source = text.slice(0, 120000);
    if (globalThis.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = 0; i < source.length; i++) {
      const c = source.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    }
    return `local-${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}-${source.length}`;
  }

  async function readFile(file) {
    const bytes = await file.arrayBuffer();
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const replacementCount = (text.match(/�/g) || []).length;
    if (replacementCount > 10) {
      try { text = new TextDecoder('shift_jis', { fatal: false }).decode(bytes); } catch (_) { /* noop */ }
    }
    return text;
  }

  async function ensureMetadata(book) {
    if (book.workTitle && book.sectionTitle && book.episodeTitle) return book;
    const guessed = guessMetadata(book.filename || book.title || 'text.txt', book.text || '');
    const updated = {
      ...book,
      workTitle: book.workTitle || guessed.workTitle,
      sectionTitle: book.sectionTitle || guessed.sectionTitle,
      episodeTitle: book.episodeTitle || guessed.episodeTitle || book.title || '無題',
      episodeOrder: Number.isFinite(book.episodeOrder) ? book.episodeOrder : guessed.episodeOrder
    };
    await saveBook(updated);
    return updated;
  }

  async function createBookFromPending() {
    if (!pendingImport) return;
    const normalized = normalizeText(pendingImport.text);
    const id = await hashText(normalized);
    const existing = await getBook(id);
    const now = Date.now();
    const metadata = readMetadataForm();
    const book = {
      ...(existing || {}),
      id,
      title: metadata.episodeTitle,
      filename: pendingImport.filename,
      text: normalized,
      addedAt: existing?.addedAt || now,
      updatedAt: now,
      lastIndex: existing?.lastIndex || 0,
      workTitle: metadata.workTitle,
      sectionTitle: metadata.sectionTitle,
      episodeTitle: metadata.episodeTitle,
      episodeOrder: metadata.episodeOrder
    };
    await saveBook(book);
    pendingImport = null;
    closeBookMetaDialog();
    await openBook(id);
    await renderBookList();
    closePanels();
    showToast(existing ? '既存の話を更新しました' : '本棚に追加しました');
  }

  function readMetadataForm() {
    const rawOrder = Number(els.metaOrder.value);
    return {
      workTitle: safeText(els.metaWork.value, '未分類'),
      sectionTitle: safeText(els.metaSection.value, '本編'),
      episodeTitle: safeText(els.metaEpisode.value, '無題'),
      episodeOrder: Number.isFinite(rawOrder) && els.metaOrder.value !== '' ? rawOrder : 999999
    };
  }

  async function openImportDialog(text, filename) {
    const guessed = guessMetadata(filename, text);
    pendingBookEdit = null;
    pendingImport = { text, filename };
    els.bookMetaDialogTitle.textContent = '本棚へ追加';
    els.metaFilename.textContent = filename;
    els.metaWork.value = guessed.workTitle;
    els.metaSection.value = guessed.sectionTitle;
    els.metaEpisode.value = guessed.episodeTitle;
    els.metaOrder.value = guessed.episodeOrder === 999999 ? '' : String(guessed.episodeOrder);
    await refreshMetadataSuggestions();
    els.bookMetaDialog.hidden = false;
    setTimeout(() => els.metaWork.focus(), 30);
  }

  async function openEditDialog(book) {
    pendingImport = null;
    pendingBookEdit = book;
    els.bookMetaDialogTitle.textContent = '本棚情報を編集';
    els.metaFilename.textContent = book.filename || '';
    els.metaWork.value = book.workTitle || '未分類';
    els.metaSection.value = book.sectionTitle || '本編';
    els.metaEpisode.value = book.episodeTitle || book.title || '無題';
    els.metaOrder.value = Number.isFinite(book.episodeOrder) && book.episodeOrder !== 999999 ? String(book.episodeOrder) : '';
    await refreshMetadataSuggestions();
    els.bookMetaDialog.hidden = false;
    setTimeout(() => els.metaEpisode.focus(), 30);
  }

  function closeBookMetaDialog() {
    els.bookMetaDialog.hidden = true;
    pendingImport = null;
    pendingBookEdit = null;
  }

  async function saveBookMetadata() {
    if (pendingImport) {
      await createBookFromPending();
      return;
    }
    if (!pendingBookEdit) return;
    const metadata = readMetadataForm();
    const updated = {
      ...pendingBookEdit,
      ...metadata,
      title: metadata.episodeTitle,
      updatedAt: Date.now()
    };
    await saveBook(updated);
    if (currentBook?.id === updated.id) {
      currentBook = updated;
      els.bookTitle.textContent = `${updated.workTitle}｜${updated.episodeTitle}`;
    }
    closeBookMetaDialog();
    await renderBookList();
    showToast('本棚情報を更新しました');
  }

  async function refreshMetadataSuggestions() {
    const books = await getAllBooks();
    const works = [...new Set(books.map(b => b.workTitle).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    els.workSuggestions.replaceChildren(...works.map(value => {
      const option = document.createElement('option'); option.value = value; return option;
    }));
    const selectedWork = els.metaWork.value.trim();
    const sections = [...new Set(books.filter(b => !selectedWork || b.workTitle === selectedWork).map(b => b.sectionTitle).filter(Boolean))]
      .sort((a, b) => compareNatural(a, b));
    els.sectionSuggestions.replaceChildren(...sections.map(value => {
      const option = document.createElement('option'); option.value = value; return option;
    }));
  }

  async function openBook(id) {
    let book = await getBook(id);
    if (!book) return;
    book = await ensureMetadata(book);
    currentBook = book;
    paragraphs = splitParagraphs(book.text);
    currentIndex = Math.min(book.lastIndex || 0, Math.max(0, paragraphs.length - 1));
    currentBookmarks = await bookmarksFor(id);
    renderContent();
    renderToc();
    renderBookmarks();
    els.bookTitle.textContent = `${book.workTitle}｜${book.episodeTitle}`;
    els.emptyState.hidden = true;
    els.content.hidden = false;
    els.bottomBar.hidden = false;
    await setMeta('lastBookId', id);
    requestAnimationFrame(() => jumpToIndex(currentIndex, false));
  }

  function isDialogueParagraph(text) {
    return /^[「『]/.test(String(text || '').trim());
  }

  function renderContent() {
    els.content.replaceChildren();
    const frag = document.createDocumentFragment();
    paragraphs.forEach((p, i) => {
      const node = document.createElement('p');
      node.dataset.index = String(i);
      node.textContent = p.text;
      if (p.heading) node.classList.add('heading');
      if (isDialogueParagraph(p.text)) node.classList.add('dialogue');
      if (isDialogueParagraph(p.text) && isDialogueParagraph(paragraphs[i + 1]?.text)) {
        node.classList.add('dialogue-followed');
      }
      frag.appendChild(node);
    });
    els.content.appendChild(frag);
    updateProgress();
  }

  function extractToc() {
    const candidates = paragraphs.map((p, i) => ({ ...p, index: i })).filter(p => p.heading);
    const chapterish = candidates.filter(p => /^(第[〇一二三四五六七八九十百0-9]+[話章節]|序章|終章|プロローグ|エピローグ|幕間)/.test(p.text.trim()));
    return chapterish.length ? chapterish : candidates.slice(0, 40);
  }

  function renderToc() {
    const toc = extractToc();
    els.tocList.replaceChildren();
    if (!toc.length) {
      const p = document.createElement('p'); p.className = 'meta'; p.textContent = '見出しを検出できませんでした。'; els.tocList.appendChild(p); return;
    }
    for (const item of toc) {
      const row = document.createElement('div'); row.className = 'toc-item';
      const btn = document.createElement('button'); btn.textContent = item.text.trim();
      btn.addEventListener('click', () => { jumpToIndex(item.index); closePanels(); });
      row.appendChild(btn); els.tocList.appendChild(row);
    }
  }

  function compareNatural(a, b) {
    return String(a).localeCompare(String(b), 'ja', { numeric: true, sensitivity: 'base' });
  }

  function progressOf(book) {
    const count = Math.max(1, splitParagraphs(book.text || '').length);
    return Math.max(0, Math.min(100, Math.round((((book.lastIndex || 0) + 1) / count) * 100)));
  }

  function groupBooks(books) {
    const works = new Map();
    for (const rawBook of books) {
      const book = {
        ...rawBook,
        workTitle: rawBook.workTitle || '未分類',
        sectionTitle: rawBook.sectionTitle || '本編',
        episodeTitle: rawBook.episodeTitle || rawBook.title || '無題',
        episodeOrder: Number.isFinite(rawBook.episodeOrder) ? rawBook.episodeOrder : 999999
      };
      if (!works.has(book.workTitle)) works.set(book.workTitle, { title: book.workTitle, books: [], updatedAt: 0, sections: new Map() });
      const work = works.get(book.workTitle);
      work.books.push(book);
      work.updatedAt = Math.max(work.updatedAt, book.updatedAt || book.addedAt || 0);
      if (!work.sections.has(book.sectionTitle)) work.sections.set(book.sectionTitle, []);
      work.sections.get(book.sectionTitle).push(book);
    }
    return [...works.values()].sort((a, b) => b.updatedAt - a.updatedAt || compareNatural(a.title, b.title));
  }

  async function renderBookList() {
    const books = await getAllBooks();
    els.bookList.replaceChildren();
    if (!books.length) {
      const empty = document.createElement('div'); empty.className = 'library-empty';
      empty.innerHTML = '<strong>本棚は空です</strong><span>TXTを追加すると、作品ごとにまとまります。</span>';
      els.bookList.appendChild(empty);
      return;
    }

    const works = groupBooks(books);
    for (const work of works) {
      const details = document.createElement('details');
      details.className = 'work-group';
      details.open = currentBook?.workTitle === work.title || works.length === 1;

      const summary = document.createElement('summary'); summary.className = 'work-summary';
      const summaryText = document.createElement('div'); summaryText.className = 'work-summary-text';
      const workTitle = document.createElement('div'); workTitle.className = 'work-title'; workTitle.textContent = work.title;
      const workMeta = document.createElement('div'); workMeta.className = 'work-meta';
      const avg = Math.round(work.books.reduce((sum, b) => sum + progressOf(b), 0) / Math.max(1, work.books.length));
      workMeta.textContent = `${work.books.length}話 ・ 平均 ${avg}%`;
      summaryText.append(workTitle, workMeta);
      const chevron = document.createElement('span'); chevron.className = 'work-chevron'; chevron.textContent = '›';
      summary.append(summaryText, chevron); details.appendChild(summary);

      const sectionEntries = [...work.sections.entries()].sort((a, b) => compareNatural(a[0], b[0]));
      const body = document.createElement('div'); body.className = 'work-body';
      for (const [sectionTitle, sectionBooksRaw] of sectionEntries) {
        const section = document.createElement('section'); section.className = 'section-group';
        const sectionHead = document.createElement('div'); sectionHead.className = 'section-head';
        const sectionName = document.createElement('h3'); sectionName.textContent = sectionTitle;
        const sectionCount = document.createElement('span'); sectionCount.textContent = `${sectionBooksRaw.length}話`;
        sectionHead.append(sectionName, sectionCount); section.appendChild(sectionHead);

        const sectionBooks = [...sectionBooksRaw].sort((a, b) => {
          const orderDiff = (a.episodeOrder ?? 999999) - (b.episodeOrder ?? 999999);
          return orderDiff || compareNatural(a.episodeTitle, b.episodeTitle);
        });

        for (const book of sectionBooks) section.appendChild(renderEpisodeRow(book));
        body.appendChild(section);
      }
      details.appendChild(body);
      els.bookList.appendChild(details);
    }
  }

  function renderEpisodeRow(book) {
    const row = document.createElement('div');
    row.className = 'episode-row';
    if (currentBook?.id === book.id) row.classList.add('current');

    const open = document.createElement('button'); open.className = 'episode-open';
    const top = document.createElement('div'); top.className = 'episode-topline';
    const title = document.createElement('span'); title.className = 'episode-title'; title.textContent = book.episodeTitle || book.title;
    const pct = document.createElement('span'); pct.className = 'episode-percent'; pct.textContent = `${progressOf(book)}%`;
    top.append(title, pct);
    const progressTrack = document.createElement('div'); progressTrack.className = 'episode-progress';
    const progressFill = document.createElement('i'); progressFill.style.width = `${progressOf(book)}%`; progressTrack.appendChild(progressFill);
    const filename = document.createElement('div'); filename.className = 'episode-file'; filename.textContent = book.filename || '';
    open.append(top, progressTrack, filename);
    open.addEventListener('click', async () => { await openBook(book.id); await renderBookList(); closePanels(); });

    const actions = document.createElement('div'); actions.className = 'episode-actions';
    const edit = document.createElement('button'); edit.className = 'episode-action'; edit.textContent = '編集'; edit.addEventListener('click', () => openEditDialog(book));
    const del = document.createElement('button'); del.className = 'episode-action danger'; del.textContent = '削除';
    del.addEventListener('click', async () => {
      if (!confirm(`「${book.episodeTitle || book.title}」を端末内の本棚から削除しますか？\nしおりも削除されます。`)) return;
      await deleteBookmarksForBook(book.id);
      await deleteBookDb(book.id);
      if (currentBook?.id === book.id) resetReader();
      await renderBookList();
      showToast('削除しました');
    });
    actions.append(edit, del);
    row.append(open, actions);
    return row;
  }

  function resetReader() {
    currentBook = null; paragraphs = []; currentBookmarks = []; currentIndex = 0;
    els.content.hidden = true; els.content.replaceChildren(); els.emptyState.hidden = false; els.bottomBar.hidden = true;
    els.bookTitle.textContent = '栞読'; els.progressText.textContent = 'TXTを読み込んでください'; els.progressFill.style.width = '0%';
  }

  function getReadingIndex() {
    if (!paragraphs.length) return 0;
    const nodes = [...els.content.querySelectorAll('p[data-index]')];
    const rr = els.reader.getBoundingClientRect();
    const targetX = settings.mode === 'vertical' ? rr.right - Math.min(70, rr.width * .18) : rr.left + Math.min(70, rr.width * .18);
    const targetY = rr.top + Math.min(105, rr.height * .22);
    let best = { idx: currentIndex, score: Infinity };
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      let dx = 0, dy = 0;
      if (targetX < r.left) dx = r.left - targetX; else if (targetX > r.right) dx = targetX - r.right;
      if (targetY < r.top) dy = r.top - targetY; else if (targetY > r.bottom) dy = targetY - r.bottom;
      const score = settings.mode === 'vertical' ? dx + dy * .25 : dy + dx * .15;
      if (score < best.score) best = { idx: Number(node.dataset.index), score };
    }
    return best.idx;
  }

  function updateReadingPosition() {
    if (!currentBook) return;
    currentIndex = getReadingIndex();
    updateProgress();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 450);
  }

  async function savePosition() {
    if (!currentBook) return;
    currentBook.lastIndex = currentIndex;
    currentBook.updatedAt = Date.now();
    await saveBook(currentBook);
  }

  function updateProgress() {
    if (!currentBook || !paragraphs.length) return;
    const pct = Math.max(0, Math.min(100, ((currentIndex + 1) / paragraphs.length) * 100));
    els.progressText.textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}% ・ ${currentBook.sectionTitle} ・ 段落 ${currentIndex + 1}/${paragraphs.length}`;
    els.progressFill.style.width = `${pct}%`;
  }

  function jumpToIndex(index, smooth = true) {
    index = Math.max(0, Math.min(index, paragraphs.length - 1));
    const el = els.content.querySelector(`p[data-index="${index}"]`);
    if (!el) return;
    currentIndex = index;
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start', inline: 'start' });
    requestAnimationFrame(resetOuterViewportX);
    updateProgress();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, smooth ? 500 : 80);
  }

  function currentExcerpt(index = currentIndex) {
    const text = paragraphs[index]?.text?.trim() || '';
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  }

  function openBookmarkDialog() {
    if (!currentBook) return;
    currentIndex = getReadingIndex();
    els.bookmarkExcerpt.textContent = currentExcerpt();
    els.bookmarkNote.value = '';
    els.bookmarkDialog.hidden = false;
    setTimeout(() => els.bookmarkNote.focus(), 50);
  }

  async function saveCurrentBookmark() {
    if (!currentBook) return;
    const bm = {
      id: `${currentBook.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      bookId: currentBook.id,
      paragraphIndex: currentIndex,
      excerpt: currentExcerpt(),
      note: els.bookmarkNote.value.trim(),
      createdAt: Date.now()
    };
    await putBookmark(bm);
    currentBookmarks = await bookmarksFor(currentBook.id);
    renderBookmarks();
    els.bookmarkDialog.hidden = true;
    showToast('しおりを挟みました');
  }

  function renderBookmarks() {
    els.bookmarkList.replaceChildren();
    if (!currentBookmarks.length) {
      const p = document.createElement('p'); p.textContent = 'しおりはまだありません。'; p.className = 'meta'; els.bookmarkList.appendChild(p); return;
    }
    currentBookmarks.forEach((bm, n) => {
      const card = document.createElement('div'); card.className = 'bookmark-card';
      const go = document.createElement('button'); go.style.width = '100%';
      const label = document.createElement('div'); label.textContent = bm.note || `しおり ${n + 1}`; label.style.fontWeight = '650';
      const ex = document.createElement('div'); ex.className = 'excerpt'; ex.textContent = bm.excerpt;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = `段落 ${bm.paragraphIndex + 1} ・ ${new Date(bm.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      go.append(label, ex, meta);
      go.addEventListener('click', () => { jumpToIndex(bm.paragraphIndex); closePanels(); });
      const actions = document.createElement('div'); actions.className = 'bookmark-actions';
      const del = document.createElement('button'); del.textContent = '削除';
      del.addEventListener('click', async () => {
        await deleteBookmarkDb(bm.id);
        currentBookmarks = await bookmarksFor(currentBook.id);
        renderBookmarks();
      });
      actions.appendChild(del); card.append(go, actions); els.bookmarkList.appendChild(card);
    });
  }

  function jumpBookmark(direction) {
    if (!currentBookmarks.length) { showToast('しおりがありません'); return; }
    currentIndex = getReadingIndex();
    let target;
    if (direction > 0) target = currentBookmarks.find(b => b.paragraphIndex > currentIndex) || currentBookmarks[0];
    else target = [...currentBookmarks].reverse().find(b => b.paragraphIndex < currentIndex) || currentBookmarks[currentBookmarks.length - 1];
    jumpToIndex(target.paragraphIndex);
  }

  function resetOuterViewportX() {
    // iOS Safari can move the page viewport horizontally when a wide vertical-writing
    // element is brought into view. Keep only the reader itself horizontally scrollable.
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
    try { window.scrollTo(0, 0); } catch (_) {}
  }

  function applySettings({ keepPosition = true } = {}) {
    const idx = keepPosition && currentBook ? getReadingIndex() : currentIndex;
    document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
    document.documentElement.style.setProperty('--line-height', settings.lineHeight);
    document.documentElement.style.setProperty('--reader-pad', `${settings.padding}px`);
    document.body.classList.remove('theme-white', 'theme-dark');
    if (settings.theme === 'white') document.body.classList.add('theme-white');
    if (settings.theme === 'dark') document.body.classList.add('theme-dark');
    els.reader.classList.toggle('horizontal', settings.mode === 'horizontal');
    els.reader.classList.toggle('vertical', settings.mode === 'vertical');
    els.horizontalBtn.classList.toggle('active', settings.mode === 'horizontal');
    els.verticalBtn.classList.toggle('active', settings.mode === 'vertical');
    els.modeBtn.textContent = settings.mode === 'horizontal' ? '縦書きへ' : '横書きへ';
    els.fontSizeRange.value = settings.fontSize; els.fontSizeValue.textContent = `${settings.fontSize}px`;
    els.lineHeightRange.value = settings.lineHeight; els.lineHeightValue.textContent = settings.lineHeight.toFixed(1);
    els.paddingRange.value = settings.padding; els.paddingValue.textContent = `${settings.padding}px`;
    els.themeSelect.value = settings.theme; els.tapToggle.checked = settings.tapToggle;
    if (settings.mode === 'horizontal') els.reader.scrollLeft = 0;
    else els.reader.scrollTop = 0;
    resetOuterViewportX();
    setMeta('settings', settings);
    if (keepPosition && currentBook) requestAnimationFrame(() => requestAnimationFrame(() => {
      jumpToIndex(idx, false);
      resetOuterViewportX();
    }));
  }

  function setMode(mode) { settings.mode = mode; applySettings(); }

  function openPanel(panel) {
    closePanels();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    els.backdrop.hidden = false;
    els.app.classList.remove('chrome-hidden');
  }

  function closePanels() {
    document.querySelectorAll('.panel.open').forEach(p => {
      p.classList.remove('open'); p.setAttribute('aria-hidden', 'true');
    });
    els.backdrop.hidden = true;
  }

  function showToast(msg) {
    clearTimeout(toastTimer);
    els.toast.textContent = msg;
    els.toast.hidden = false;
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1700);
  }

  function bindEvents() {
    els.libraryBtn.addEventListener('click', async () => { await renderBookList(); openPanel(els.libraryPanel); });
    els.settingsBtn.addEventListener('click', () => openPanel(els.settingsPanel));
    els.tocBtn.addEventListener('click', () => openPanel(els.tocPanel));
    els.backdrop.addEventListener('click', closePanels);
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closePanels));

    [els.openFileBtn, els.openFileHero].forEach(b => b.addEventListener('click', () => els.fileInput.click()));
    els.fileInput.addEventListener('change', async () => {
      const file = els.fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await readFile(file);
        await openImportDialog(text, file.name);
      } catch (e) {
        console.error(e); showToast('TXTを読み込めませんでした');
      } finally {
        els.fileInput.value = '';
      }
    });

    els.loadSampleBtn.addEventListener('click', async () => {
      try {
        const r = await fetch('./01_天王寺剛花_第一話_放課後.txt');
        const text = await r.text();
        pendingImport = { text, filename: '01_天王寺剛花_第一話_放課後.txt' };
        els.metaWork.value = '天王寺剛花';
        els.metaSection.value = '本編';
        els.metaEpisode.value = '第一話 放課後';
        els.metaOrder.value = '1';
        await createBookFromPending();
      } catch (e) {
        console.error(e); showToast('サンプルを開けませんでした');
      }
    });

    els.metaWork.addEventListener('input', () => refreshMetadataSuggestions());
    els.saveBookMeta.addEventListener('click', () => saveBookMetadata().catch(e => { console.error(e); showToast('保存できませんでした'); }));
    els.cancelBookMeta.addEventListener('click', closeBookMetaDialog);
    els.bookMetaDialog.addEventListener('click', e => { if (e.target === els.bookMetaDialog) closeBookMetaDialog(); });

    els.horizontalBtn.addEventListener('click', () => setMode('horizontal'));
    els.verticalBtn.addEventListener('click', () => setMode('vertical'));
    els.modeBtn.addEventListener('click', () => setMode(settings.mode === 'horizontal' ? 'vertical' : 'horizontal'));
    els.fontSizeRange.addEventListener('input', e => { settings.fontSize = Number(e.target.value); applySettings(); });
    els.lineHeightRange.addEventListener('input', e => { settings.lineHeight = Number(e.target.value); applySettings(); });
    els.paddingRange.addEventListener('input', e => { settings.padding = Number(e.target.value); applySettings(); });
    els.themeSelect.addEventListener('change', e => { settings.theme = e.target.value; applySettings(); });
    els.tapToggle.addEventListener('change', e => { settings.tapToggle = e.target.checked; applySettings({ keepPosition: false }); });

    els.bookmarkBtn.addEventListener('click', openBookmarkDialog);
    els.addBookmarkInPanel.addEventListener('click', openBookmarkDialog);
    els.cancelBookmark.addEventListener('click', () => { els.bookmarkDialog.hidden = true; });
    els.saveBookmark.addEventListener('click', saveCurrentBookmark);
    els.bookmarkDialog.addEventListener('click', e => { if (e.target === els.bookmarkDialog) els.bookmarkDialog.hidden = true; });
    els.prevBookmarkBtn.addEventListener('click', () => jumpBookmark(-1));
    els.nextBookmarkBtn.addEventListener('click', () => jumpBookmark(1));

    els.reader.addEventListener('scroll', () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(updateReadingPosition);
    }, { passive: true });
    els.reader.addEventListener('click', e => {
      if (!settings.tapToggle || !currentBook || e.target.closest('button,a,input,select')) return;
      els.app.classList.toggle('chrome-hidden');
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition(); });
    window.addEventListener('beforeunload', savePosition);
  }

  async function init() {
    db = await openDb();
    const savedSettings = (await getMeta('settings')) || {};
    // v5: move users who were still on the old defaults to the new, slightly
    // smaller defaults. Explicitly customized values are preserved.
    if (savedSettings.fontSize === 19 && savedSettings.lineHeight === 1.9) {
      savedSettings.fontSize = 18;
      savedSettings.lineHeight = 1.8;
    }
    settings = { ...defaultSettings, ...savedSettings };
    applySettings({ keepPosition: false });
    bindEvents();
    await renderBookList();
    const lastBookId = await getMeta('lastBookId');
    if (lastBookId && await getBook(lastBookId)) await openBook(lastBookId);
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.error));
    }
  }

  init().catch(err => {
    console.error(err);
    alert('アプリの初期化に失敗しました。ブラウザのストレージ設定を確認してください。');
  });
})();
