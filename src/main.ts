/**
 * Novel Reader — M3
 * 分页：CSS multi-column（column-fill: auto + 固定高），横向滚动按列翻页。
 * 渲染：按章按需渲染，DOM 中只保留当前章节；单文件大书按标题切成虚拟章。
 * 进度：（章节序号 + 段落锚点 + 章内页比例）三重冗余，页码永不落盘。
 * 移动端红线：不 import fs/path/electron；正则不使用 lookbehind；单文件构建。
 */
import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from 'obsidian';

export const NOVEL_READER_VIEW_TYPE = 'novel-reader-view';
/** 单文件大书无标题时，按此字数切虚拟章（在段落边界断开） */
const CHUNK_SIZE = 8000;

const GAP = 48;
const FONT_MIN = 12;
const FONT_MAX = 30;
const LH_MIN = 1.4;
const LH_MAX = 2.6;

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  theme: 'auto' | 'sepia' | 'dark';
  immersive: boolean;
}

export interface BookProgress {
  chapter: number;
  cid: number;
  percent: number;
  /** 全书百分比，用于书架展示 */
  overall: number;
  /** 最后阅读时间（epoch ms），用于书架排序 */
  updatedAt: number;
}

export interface ShelfEntry {
  key: string;
  kind: 'file' | 'folder';
  title: string;
  detail: string;
  overall: number;
  updatedAt: number;
}

export interface BookmarkItem {
  chapter: number;
  cid: number;
  percent: number;
  excerpt: string;
}

export interface BookConfig {
  files: string[];
}

export interface PluginData {
  settings: ReaderSettings;
  lastBook: string | null;
  books: Record<string, BookProgress>;
  bookConfig: Record<string, BookConfig>;
  bookmarks: Record<string, BookmarkItem[]>;
}

const DEFAULTS: PluginData = {
  settings: { fontSize: 17, lineHeight: 1.9, theme: 'auto', immersive: true },
  lastBook: null,
  books: {},
  bookConfig: {},
  bookmarks: {},
};

/** 兼容旧版本（v0.3.0 及以前）的进度结构：缺 chapter 字段时兜底为第 0 章 */
function normalizeProgress(raw: unknown): BookProgress | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    chapter: Math.max(0, Math.floor(num(rec.chapter, 0))),
    cid: Math.max(0, Math.floor(num(rec.cid, 0))),
    percent: Math.min(1, Math.max(0, num(rec.percent, 0))),
    overall: Math.min(100, Math.max(0, num(rec.overall, 0))),
    updatedAt: typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
  };
}

interface RenderChapter {
  file: TFile;
  title: string;
  level: number;
  start?: number;
  end?: number;
}

interface JumpTarget {
  cid?: number;
  page?: number;
  percent?: number;
  last?: boolean;
}

/* ---------------- 插件入口 ---------------- */

export default class NovelReaderPlugin extends Plugin {
  public data: PluginData = DEFAULTS;
  private saveTimer: number | null = null;

  public async onload(): Promise<void> {
    const loaded = await this.loadData();
    this.data = {
      settings: { ...DEFAULTS.settings, ...((loaded && loaded.settings) || {}) },
      lastBook: (loaded && loaded.lastBook) || null,
      books: (loaded && loaded.books) || {},
      bookConfig: (loaded && loaded.bookConfig) || {},
      bookmarks: (loaded && loaded.bookmarks) || {},
    };
    // 把历史数据（可能缺 chapter 字段）统一规范化，避免老版本升级后定位异常
    for (const key of Object.keys(this.data.books)) {
      const fixed = normalizeProgress(this.data.books[key]);
      if (fixed) {
        this.data.books[key] = fixed;
      } else {
        delete this.data.books[key];
      }
    }

    this.registerView(NOVEL_READER_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
      return new NovelReaderView(leaf, this);
    });

    this.addRibbonIcon('book-open', '小说阅读器', () => {
      void this.openReader();
    });

    this.addCommand({
      id: 'open-reader',
      name: '打开阅读器',
      callback: () => {
        void this.openReader();
      },
    });

    this.addCommand({
      id: 'pick-book',
      name: '选择书籍',
      checkCallback: (checking: boolean): boolean => {
        const view = this.getActiveReaderView();
        if (!view) {
          return false;
        }
        if (!checking) {
          this.openPicker(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'open-book-shelf',
      name: '打开书架',
      checkCallback: (checking: boolean): boolean => {
        const view = this.getActiveReaderView();
        if (!view) {
          return false;
        }
        if (!checking) {
          new BookshelfModal(this, view).open();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'toggle-emulate-mobile',
      name: '调试：切换移动端模拟',
      checkCallback: (checking: boolean): boolean => {
        const app = this.app as unknown as {
          emulateMobile?: (value: boolean) => void;
          isMobile?: boolean;
        };
        if (typeof app.emulateMobile !== 'function') {
          return false;
        }
        if (!checking) {
          const target = !app.isMobile;
          app.emulateMobile(target);
          new Notice(target ? '已切换到移动端模拟' : '已切回桌面模式');
        }
        return true;
      },
    });
  }

  public onunload(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.saveData(this.data);
  }

  public saveSoon(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.data);
    }, 800);
  }

  public async openReader(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(NOVEL_READER_VIEW_TYPE);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({
        type: NOVEL_READER_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof NovelReaderView && !view.hasSource) {
      const last = this.data.lastBook;
      if (last) {
        const af: TAbstractFile | null = this.app.vault.getAbstractFileByPath(last);
        if (af instanceof TFile) {
          await view.openSource({ kind: 'file', file: af });
          return;
        }
        if (af instanceof TFolder) {
          await view.openSource({ kind: 'folder', folder: af });
          return;
        }
      }
      this.openPicker(view);
    }
  }

  public openPicker(view: NovelReaderView): void {
    new BookSuggester(this, view).open();
  }

  /** 书架：已读过（有进度记录）且仍存在的书，按最近阅读排序 */
  public getShelf(): ShelfEntry[] {
    const entries: ShelfEntry[] = [];
    for (const key of Object.keys(this.data.books)) {
      const af = this.app.vault.getAbstractFileByPath(key);
      const progress = this.data.books[key];
      if (af instanceof TFolder) {
        const count = af.children.filter(
          (c): c is TFile => c instanceof TFile && c.extension === 'md'
        ).length;
        entries.push({
          key,
          kind: 'folder',
          title: af.name,
          detail: `文件夹 · ${count} 篇`,
          overall: progress.overall,
          updatedAt: progress.updatedAt,
        });
      } else if (af instanceof TFile) {
        entries.push({
          key,
          kind: 'file',
          title: af.basename,
          detail: '单文件',
          overall: progress.overall,
          updatedAt: progress.updatedAt,
        });
      }
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 从书架移除：清掉进度、书签与章节配置（书本身不动） */
  public removeFromShelf(key: string): void {
    delete this.data.books[key];
    delete this.data.bookmarks[key];
    delete this.data.bookConfig[key];
    if (this.data.lastBook === key) {
      this.data.lastBook = null;
    }
    this.saveSoon();
  }

  private getActiveReaderView(): NovelReaderView | null {
    const leaves = this.app.workspace.getLeavesOfType(NOVEL_READER_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof NovelReaderView) {
        return leaf.view;
      }
    }
    return null;
  }
}

/* ---------------- 工具 ---------------- */

/** 自然排序：`第2章` 排在 `第10章` 前面。无 lookbehind。 */
function naturalCompare(a: string, b: string): number {
  const parts = /(\d+|\D+)/g;
  const as = a.match(parts) || [];
  const bs = b.match(parts) || [];
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ad = /^\d/.test(as[i]);
    const bd = /^\d/.test(bs[i]);
    if (ad && bd) {
      const diff = parseInt(as[i], 10) - parseInt(bs[i], 10);
      if (diff !== 0) {
        return diff;
      }
    } else {
      const cmp = as[i].localeCompare(bs[i]);
      if (cmp !== 0) {
        return cmp;
      }
    }
  }
  return as.length - bs.length;
}

function touchDistance(a: Touch, b: Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 章节名启发式：文件夹书首次打开时的默认勾选。无 lookbehind。 */
function chapterLike(name: string): boolean {
  if (/第.{0,4}[章節节卷回部集]/.test(name)) {
    return true;
  }
  if (/^\d+([._、\-\s]|\b)/.test(name)) {
    return true;
  }
  return /chapter/i.test(name);
}

/** 无标题的长文本按段落边界切成若干虚拟章 */
function splitByLength(
  text: string,
  size: number
): Array<{ title: string; start: number; end: number }> {
  const out: Array<{ title: string; start: number; end: number }> = [];
  let start = 0;
  let idx = 1;
  while (start < text.length) {
    if (text.length - start <= size) {
      out.push({ title: `第 ${idx} 段`, start, end: text.length });
      break;
    }
    const tail = text.slice(start, start + size);
    const cut = Math.max(tail.lastIndexOf('\n\n'), tail.lastIndexOf('\n'));
    const end = cut > size * 0.4 ? start + cut + 1 : start + size;
    out.push({ title: `第 ${idx} 段`, start, end });
    start = end;
    idx += 1;
  }
  return out;
}

/* ---------------- 阅读视图 ---------------- */

type BookSource =
  | { kind: 'file'; file: TFile }
  | { kind: 'folder'; folder: TFolder };

interface TocEntry {
  label: string;
  level: number;
  onClick: () => void;
}

export class NovelReaderView extends ItemView {
  public readonly plugin: NovelReaderPlugin;

  private source: BookSource | null = null;
  private chapters: RenderChapter[] = [];
  private chapterIndex = 0;
  private viewportEl: HTMLElement | null = null;
  private pageEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private sheetEl: HTMLElement | null = null;
  private themeBtnEl: HTMLElement | null = null;
  private cidEls: HTMLElement[] = [];
  private pageCount = 1;
  private ro: ResizeObserver | null = null;
  private scrollRaf = 0;
  private touchX = 0;
  private touchY = 0;
  private touchT = 0;
  private pinchDist = 0;
  private pinchFont = 0;
  private suppressClick = false;
  private pinchRaf = 0;

  constructor(leaf: WorkspaceLeaf, plugin: NovelReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  public get hasSource(): boolean {
    return this.source !== null;
  }

  public getViewType(): string {
    return NOVEL_READER_VIEW_TYPE;
  }

  public getDisplayText(): string {
    if (!this.source) {
      return '小说阅读器';
    }
    return this.source.kind === 'file' ? this.source.file.basename : this.source.folder.name;
  }

  public getIcon(): string {
    return 'book-open';
  }

  public async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!this.source) {
          return;
        }
        const gone =
          (this.source.kind === 'file' && this.source.file.path === file.path) ||
          (this.source.kind === 'folder' && this.source.folder.path === file.path) ||
          this.chapters.some((c) => c.file.path === file.path);
        if (gone) {
          this.showEmptyState();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!this.source) {
          return;
        }
        if (this.source.kind === 'file' && this.source.file.path === oldPath) {
          if (file instanceof TFile) {
            this.source = { kind: 'file', file };
            this.chapters.forEach((c) => {
              if (c.file.path === oldPath) {
                c.file = file;
              }
            });
          } else {
            this.showEmptyState();
          }
          return;
        }
        if (this.source.kind === 'folder' && this.source.folder.path === oldPath) {
          if (file instanceof TFolder) {
            this.source = { kind: 'folder', folder: file };
          } else {
            this.showEmptyState();
          }
        }
      })
    );
    this.showEmptyState();
  }

  public async onClose(): Promise<void> {
    this.saveProgressNow();
    document.body.removeClass('nr-immersive');
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.scrollRaf) {
      window.cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
    if (this.pinchRaf) {
      window.cancelAnimationFrame(this.pinchRaf);
      this.pinchRaf = 0;
    }
  }

  public async openSource(src: BookSource): Promise<void> {
    this.source = src;
    this.plugin.data.lastBook = this.sourceKey();
    this.plugin.saveSoon();

    const files = src.kind === 'file' ? [src.file] : await this.resolveFolderChapters(src.folder);
    if (files.length === 0) {
      this.showEmptyState();
      return;
    }

    this.chapters = await this.buildChapters(files);
    if (this.chapters.length === 0) {
      new Notice('这本书没有可渲染的内容');
      this.showEmptyState();
      return;
    }

    this.contentEl.empty();
    this.contentEl.addClass('novel-reader');
    this.buildShell();
    this.applySettings();
    this.applyImmersive();

    this.ro = new ResizeObserver(() => {
      this.relayout(this.currentAnchor());
    });
    this.ro.observe(this.viewportEl!);

    const progress = normalizeProgress(this.plugin.data.books[this.sourceKey()]);
    const index = progress
      ? Math.min(this.chapters.length - 1, Math.max(0, progress.chapter))
      : 0;
    const target: JumpTarget = progress
      ? { cid: progress.cid, percent: progress.percent }
      : { page: 0 };
    await this.loadChapter(index, target);
  }

  /** 文件夹书：按已保存的章节配置过滤，首次打开弹勾选框 */
  private async resolveFolderChapters(folder: TFolder): Promise<TFile[]> {
    const all = listChapterFiles(folder);
    if (all.length === 0) {
      new Notice('该文件夹没有 Markdown 文件');
      return [];
    }
    const cfg = this.plugin.data.bookConfig[folder.path];
    if (cfg && cfg.files.length > 0) {
      const wanted = new Set(cfg.files);
      return all.filter((f) => wanted.has(f.name));
    }
    const picked = await pickChapters(this.app, folder, all);
    if (picked.length === 0) {
      return [];
    }
    this.plugin.data.bookConfig[folder.path] = { files: picked.map((f) => f.name) };
    this.plugin.saveSoon();
    return picked;
  }

  /** 构建章节列表：文件夹=每文件一章；单文件=按标题切虚拟章，无标题则按字数切 */
  private async buildChapters(files: TFile[]): Promise<RenderChapter[]> {
    const chapters: RenderChapter[] = [];
    if (this.source && this.source.kind === 'folder') {
      for (const file of files) {
        chapters.push({ file, title: file.basename, level: 1 });
      }
      return chapters;
    }
    const file = files[0];
    const text = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const headings = (cache && cache.headings) || [];
    if (headings.length >= 2) {
      for (let i = 0; i < headings.length; i++) {
        const start = headings[i].position.start.offset;
        const end = i + 1 < headings.length ? headings[i + 1].position.start.offset : text.length;
        chapters.push({ file, title: headings[i].heading, level: headings[i].level, start, end });
      }
      return chapters;
    }
    for (const chunk of splitByLength(text, CHUNK_SIZE)) {
      chapters.push({ file, title: chunk.title, level: 1, start: chunk.start, end: chunk.end });
    }
    if (chapters.length === 0) {
      chapters.push({ file, title: file.basename, level: 1 });
    }
    return chapters;
  }

  public sourceKey(): string {
    if (!this.source) {
      return '';
    }
    return this.source.kind === 'file' ? this.source.file.path : this.source.folder.path;
  }

  private bookTitle(): string {
    if (!this.source) {
      return '';
    }
    return this.source.kind === 'file' ? this.source.file.basename : this.source.folder.name;
  }

  /* ---------- 界面骨架与交互 ---------- */

  private buildShell(): void {
    this.viewportEl = this.contentEl.createDiv({ cls: 'novel-reader-viewport' });
    this.pageEl = this.viewportEl.createDiv({ cls: 'nr-page' });

    const overlay = this.contentEl.createDiv({ cls: 'nr-overlay' });
    this.registerDomEvent(overlay, 'click', (evt: MouseEvent) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const rect = overlay.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      if (x < rect.width * 0.25) {
        this.turnPage(-1);
      } else if (x > rect.width * 0.75) {
        this.turnPage(1);
      } else {
        this.toggleSheet();
      }
    });

    // 滑动翻页（单指横滑）+ 捏合缩放（双指）
    this.registerDomEvent(
      overlay,
      'touchstart',
      (evt: TouchEvent) => {
        if (evt.touches.length === 1) {
          this.touchX = evt.touches[0].clientX;
          this.touchY = evt.touches[0].clientY;
          this.touchT = Date.now();
        } else if (evt.touches.length === 2) {
          this.pinchDist = touchDistance(evt.touches[0], evt.touches[1]);
          this.pinchFont = this.plugin.data.settings.fontSize;
        }
      },
      { passive: true }
    );
    this.registerDomEvent(
      overlay,
      'touchmove',
      (evt: TouchEvent) => {
        if (evt.touches.length === 2 && this.pinchDist > 0) {
          evt.preventDefault();
          const dist = touchDistance(evt.touches[0], evt.touches[1]);
          const next = Math.min(
            FONT_MAX,
            Math.max(FONT_MIN, Math.round((this.pinchFont * dist) / this.pinchDist))
          );
          this.suppressClick = true;
          this.applyFontSizeLive(next);
        }
      },
      { passive: false }
    );
    this.registerDomEvent(
      overlay,
      'touchend',
      (evt: TouchEvent) => {
        if (evt.touches.length === 0 && this.pinchDist > 0) {
          this.pinchDist = 0;
          this.plugin.saveSoon();
          return;
        }
        if (evt.changedTouches.length === 1 && this.touchT > 0) {
          const dx = evt.changedTouches[0].clientX - this.touchX;
          const dy = evt.changedTouches[0].clientY - this.touchY;
          const dt = Date.now() - this.touchT;
          this.touchT = 0;
          if (dt < 500 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            this.suppressClick = true;
            this.turnPage(dx < 0 ? 1 : -1);
          }
        }
      },
      { passive: true }
    );

    // 桌面端触控板横滑 / 键盘翻页
    this.registerDomEvent(
      overlay,
      'wheel',
      (evt: WheelEvent) => {
        if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
          evt.preventDefault();
          this.turnPage(evt.deltaX > 0 ? 1 : -1);
        }
      },
      { passive: false }
    );
    this.containerEl.tabIndex = 0;
    this.registerDomEvent(this.containerEl, 'keydown', (evt: KeyboardEvent) => {
      if (evt.key === 'ArrowRight' || evt.key === 'PageDown' || evt.key === ' ') {
        evt.preventDefault();
        this.turnPage(1);
      } else if (evt.key === 'ArrowLeft' || evt.key === 'PageUp') {
        evt.preventDefault();
        this.turnPage(-1);
      }
    });

    this.statusEl = this.contentEl.createDiv({ cls: 'nr-status' });
    this.buildSheet();
    this.registerDomEvent(this.viewportEl, 'scroll', () => {
      if (this.scrollRaf) {
        return;
      }
      this.scrollRaf = window.requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.updateStatus();
        this.saveProgressNow();
      });
    });
  }

  private buildSheet(): void {
    this.sheetEl = this.contentEl.createDiv({ cls: 'nr-sheet' });
    const row = this.sheetEl.createDiv({ cls: 'nr-sheet-row' });

    const mkBtn = (label: string, onClick: () => void): HTMLElement => {
      const btn = row.createEl('button', { cls: 'nr-btn', text: label });
      this.registerDomEvent(btn, 'click', (evt: MouseEvent) => {
        evt.stopPropagation();
        onClick();
      });
      return btn;
    };

    mkBtn('A−', () => this.changeFont(-1));
    mkBtn('A+', () => this.changeFont(1));
    mkBtn('行距−', () => this.changeLineHeight(-0.1));
    mkBtn('行距+', () => this.changeLineHeight(0.1));
    this.themeBtnEl = mkBtn(this.themeLabel(), () => this.cycleTheme());
    mkBtn(this.immersiveLabel(), () => this.toggleImmersive());
    mkBtn('目录', () => this.openToc());
    mkBtn('书签', () => this.toggleBookmark());
    mkBtn('搜索', () => void this.openSearch());
    mkBtn('书架', () => this.openBookshelf());
    mkBtn('换书', () => this.plugin.openPicker(this));
  }

  private toggleSheet(force?: boolean): void {
    if (!this.sheetEl) {
      return;
    }
    const show = force !== undefined ? force : !this.sheetEl.hasClass('nr-open');
    this.sheetEl.toggleClass('nr-open', show);
  }

  /* ---------- 排版与主题 ---------- */

  private changeFont(delta: number): void {
    const s = this.plugin.data.settings;
    s.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, s.fontSize + delta));
    this.plugin.saveSoon();
    this.reflow();
  }

  private changeLineHeight(delta: number): void {
    const s = this.plugin.data.settings;
    s.lineHeight = Math.min(LH_MAX, Math.max(LH_MIN, Math.round((s.lineHeight + delta) * 10) / 10));
    this.plugin.saveSoon();
    this.reflow();
  }

  /** 捏合过程中实时应用字号（rAF 节流重排，抬手时才落盘） */
  private applyFontSizeLive(size: number): void {
    const s = this.plugin.data.settings;
    if (s.fontSize === size) {
      return;
    }
    s.fontSize = size;
    this.contentEl.style.setProperty('--nr-font', `${size}px`);
    if (this.pinchRaf) {
      window.cancelAnimationFrame(this.pinchRaf);
    }
    this.pinchRaf = window.requestAnimationFrame(() => {
      this.pinchRaf = 0;
      this.reflow();
    });
  }

  private cycleTheme(): void {
    const order: Array<'auto' | 'sepia' | 'dark'> = ['auto', 'sepia', 'dark'];
    const s = this.plugin.data.settings;
    s.theme = order[(order.indexOf(s.theme) + 1) % order.length];
    this.plugin.saveSoon();
    if (this.themeBtnEl) {
      this.themeBtnEl.setText(this.themeLabel());
    }
    this.applyTheme();
  }

  private themeLabel(): string {
    const t = this.plugin.data.settings.theme;
    return t === 'auto' ? '跟随主题' : t === 'sepia' ? '米色' : '暗黑';
  }

  private immersiveLabel(): string {
    return this.plugin.data.settings.immersive ? '沉浸开' : '沉浸关';
  }

  private toggleImmersive(): void {
    const s = this.plugin.data.settings;
    s.immersive = !s.immersive;
    this.plugin.saveSoon();
    this.applyImmersive();
    const btns = this.sheetEl ? Array.from(this.sheetEl.querySelectorAll('.nr-btn')) : [];
    for (const btn of btns) {
      if (btn.getText() === '沉浸开' || btn.getText() === '沉浸关') {
        btn.setText(this.immersiveLabel());
      }
    }
  }

  private applyImmersive(): void {
    document.body.toggleClass('nr-immersive', this.plugin.data.settings.immersive && !!this.source);
  }

  private applyTheme(): void {
    const theme = this.plugin.data.settings.theme;
    this.contentEl.toggleClass('nr-sepia', theme === 'sepia');
    this.contentEl.toggleClass('nr-dark', theme === 'dark');
  }

  private applySettings(): void {
    const s = this.plugin.data.settings;
    this.contentEl.style.setProperty('--nr-font', `${s.fontSize}px`);
    this.contentEl.style.setProperty('--nr-lh', String(s.lineHeight));
    if (this.themeBtnEl) {
      this.themeBtnEl.setText(this.themeLabel());
    }
    this.applyTheme();
  }

  /* ---------- 章节渲染与分页 ---------- */

  private async loadChapter(index: number, target: JumpTarget): Promise<void> {
    if (!this.pageEl || this.chapters.length === 0) {
      return;
    }
    this.chapterIndex = Math.min(this.chapters.length - 1, Math.max(0, index));
    const chapter = this.chapters[this.chapterIndex];

    let md = await this.app.vault.cachedRead(chapter.file);
    if (chapter.start !== undefined && chapter.end !== undefined) {
      md = md.slice(chapter.start, chapter.end);
    }

    this.pageEl.empty();
    const holder = this.pageEl.createDiv({ cls: 'nr-chapter' });
    await MarkdownRenderer.render(this.app, md, holder, chapter.file.path, this);

    this.cidEls = [];
    let cid = 0;
    for (const el of Array.from(holder.children)) {
      (el as HTMLElement).dataset.cid = String(cid++);
      this.cidEls.push(el as HTMLElement);
    }

    this.relayout(undefined, target);
    this.saveProgressNow();
  }

  private reflow(): void {
    this.relayout(this.currentAnchor());
  }

  /** 重算分页并定位：anchor 用于重排（保持当前位置），target 用于章节加载后的跳转 */
  private relayout(anchor?: BookProgress, target?: JumpTarget): void {
    if (!this.viewportEl || !this.pageEl) {
      return;
    }
    this.pageEl.style.columnWidth = `${this.viewportEl.clientWidth}px`;
    this.pageCount = Math.max(1, Math.ceil(this.pageEl.scrollWidth / this.stride()));

    if (target) {
      this.restoreTarget(target);
    } else if (anchor) {
      this.restoreAnchor(anchor);
    }
    this.updateStatus();
  }

  private restoreAnchor(anchor: BookProgress): void {
    if (!this.viewportEl) {
      return;
    }
    const el =
      anchor.cid >= 0 && anchor.cid < this.cidEls.length ? this.cidEls[anchor.cid] : undefined;
    if (el) {
      const col = Math.floor(this.contentX(el) / this.stride());
      this.viewportEl.scrollTo({ left: Math.max(0, col) * this.stride() });
      return;
    }
    this.viewportEl.scrollTo({ left: anchor.percent * this.maxScroll() });
  }

  private restoreTarget(target: JumpTarget): void {
    if (!this.viewportEl) {
      return;
    }
    if (target.last) {
      this.viewportEl.scrollTo({ left: (this.pageCount - 1) * this.stride() });
      return;
    }
    const el =
      target.cid !== undefined && target.cid >= 0 && target.cid < this.cidEls.length
        ? this.cidEls[target.cid]
        : undefined;
    if (el) {
      const col = Math.floor(this.contentX(el) / this.stride());
      this.viewportEl.scrollTo({ left: Math.max(0, col) * this.stride() });
      return;
    }
    if (target.percent !== undefined && target.percent > 0) {
      this.viewportEl.scrollTo({ left: target.percent * this.maxScroll() });
      return;
    }
    this.viewportEl.scrollTo({ left: (target.page || 0) * this.stride() });
  }

  private stride(): number {
    return (this.viewportEl ? this.viewportEl.clientWidth : 0) + GAP;
  }

  private maxScroll(): number {
    if (!this.viewportEl || !this.pageEl) {
      return 1;
    }
    return Math.max(1, this.pageEl.scrollWidth - this.viewportEl.clientWidth);
  }

  private contentX(el: HTMLElement): number {
    if (!this.viewportEl || !this.pageEl) {
      return 0;
    }
    return (
      el.getBoundingClientRect().left +
      this.viewportEl.scrollLeft -
      this.pageEl.getBoundingClientRect().left
    );
  }

  private currentPageIndex(): number {
    if (!this.viewportEl) {
      return 0;
    }
    return Math.max(0, Math.round(this.viewportEl.scrollLeft / this.stride()));
  }

  private turnPage(dir: 1 | -1): void {
    if (!this.viewportEl) {
      return;
    }
    this.toggleSheet(false);
    const target = this.currentPageIndex() + dir;
    if (target < 0) {
      if (this.chapterIndex > 0) {
        void this.loadChapter(this.chapterIndex - 1, { last: true });
      }
      return;
    }
    if (target >= this.pageCount) {
      if (this.chapterIndex < this.chapters.length - 1) {
        void this.loadChapter(this.chapterIndex + 1, { page: 0 });
      }
      return;
    }
    this.viewportEl.scrollTo({ left: target * this.stride(), behavior: 'smooth' });
  }

  private currentAnchor(): BookProgress {
    if (!this.viewportEl) {
      return { chapter: this.chapterIndex, cid: 0, percent: 0, overall: 0, updatedAt: 0 };
    }
    const edge = this.viewportEl.scrollLeft + 2;
    let cid = 0;
    for (let i = 0; i < this.cidEls.length; i++) {
      if (this.contentX(this.cidEls[i]) <= edge) {
        cid = i;
      } else {
        break;
      }
    }
    const percent = Math.min(1, Math.max(0, this.viewportEl.scrollLeft / this.maxScroll()));
    return { chapter: this.chapterIndex, cid, percent, overall: 0, updatedAt: 0 };
  }

  private saveProgressNow(): void {
    if (!this.source || !this.viewportEl) {
      return;
    }
    const anchor = this.currentAnchor();
    anchor.overall = this.overallPercent();
    anchor.updatedAt = Date.now();
    this.plugin.data.books[this.sourceKey()] = anchor;
    this.plugin.saveSoon();
  }

  /** 全书百分比（按章节进度估算，足够书架展示用） */
  private overallPercent(): number {
    if (this.chapters.length === 0) {
      return 0;
    }
    const page = Math.min(this.pageCount, this.currentPageIndex() + 1);
    return Math.round(((this.chapterIndex + page / this.pageCount) / this.chapters.length) * 100);
  }

  private updateStatus(): void {
    if (!this.statusEl) {
      return;
    }
    const page = Math.min(this.pageCount, this.currentPageIndex() + 1);
    const totalChapters = Math.max(1, this.chapters.length);
    const overall = this.overallPercent();
    this.statusEl.setText(
      `${this.bookTitle()} · 第 ${this.chapterIndex + 1}/${totalChapters} 章 · ${page}/${this.pageCount} 页 · ${overall}%`
    );
  }

  private async openToc(): Promise<void> {
    if (this.chapters.length === 0) {
      return;
    }
    const entries: TocEntry[] = this.chapters.map((chapter, i) => ({
      label: chapter.title,
      level: chapter.level,
      onClick: () => void this.loadChapter(i, { page: 0 }),
    }));
    this.toggleSheet(false);
    new TocModal(this.app, entries).open();
  }

  /** 关闭当前书籍、回到空状态（书架里移除某书后调用） */
  public closeSource(): void {
    this.showEmptyState();
  }

  private openBookshelf(): void {
    this.toggleSheet(false);
    new BookshelfModal(this.plugin, this).open();
  }

  /** 取出某一章的 Markdown 正文（虚拟章按偏移量切片） */
  private async chapterText(chapter: RenderChapter): Promise<string> {
    const text = await this.app.vault.cachedRead(chapter.file);
    if (chapter.start !== undefined && chapter.end !== undefined) {
      return text.slice(chapter.start, chapter.end);
    }
    return text;
  }

  /** 书签：在当前位置添加/移除（同一位置再点一次即移除） */
  private toggleBookmark(): void {
    if (!this.source) {
      return;
    }
    const key = this.sourceKey();
    const anchor = this.currentAnchor();
    const list = this.plugin.data.bookmarks[key] || [];
    const hit = list.findIndex(
      (b) => b.chapter === anchor.chapter && Math.abs(b.percent - anchor.percent) < 0.005
    );
    if (hit >= 0) {
      list.splice(hit, 1);
      new Notice('已移除书签');
    } else {
      const anchorEl = this.cidEls[anchor.cid];
      const raw = anchorEl ? anchorEl.getText() : '';
      const excerpt = raw.replace(/\s+/g, ' ').slice(0, 24) || this.chapters[anchor.chapter].title;
      list.push({ chapter: anchor.chapter, cid: anchor.cid, percent: anchor.percent, excerpt });
      new Notice(`已添加书签：${excerpt}`);
    }
    this.plugin.data.bookmarks[key] = list;
    this.plugin.saveSoon();
    this.toggleSheet(false);
  }

  /** 书内搜索：预先取出各章正文，交给搜索弹窗 */
  private async openSearch(): Promise<void> {
    if (this.chapters.length === 0) {
      return;
    }
    const texts: string[] = [];
    for (const chapter of this.chapters) {
      texts.push(await this.chapterText(chapter));
    }
    this.toggleSheet(false);
    new ReaderSearchModal(this.app, this, this.chapters, texts).open();
  }

  /** 跳到某章，并定位到首个包含指定文字的段落 */
  public async jumpToChapterText(chapterIndex: number, query: string): Promise<void> {
    await this.loadChapter(chapterIndex, { page: 0 });
    const lower = query.toLowerCase();
    for (const el of this.cidEls) {
      if (el.getText().toLowerCase().includes(lower)) {
        if (this.viewportEl) {
          const col = Math.floor(this.contentX(el) / this.stride());
          this.viewportEl.scrollTo({ left: Math.max(0, col) * this.stride(), behavior: 'smooth' });
        }
        return;
      }
    }
  }

  public getBookmarks(): BookmarkItem[] {
    if (!this.source) {
      return [];
    }
    return this.plugin.data.bookmarks[this.sourceKey()] || [];
  }

  public async jumpToBookmark(item: BookmarkItem): Promise<void> {
    await this.loadChapter(item.chapter, { cid: item.cid, percent: item.percent });
  }

  private showEmptyState(): void {
    this.source = null;
    this.chapters = [];
    this.chapterIndex = 0;
    this.cidEls = [];
    this.pageCount = 1;
    document.body.removeClass('nr-immersive');
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    this.contentEl.empty();
    this.contentEl.addClass('novel-reader');
    const empty = this.contentEl.createDiv({ cls: 'novel-reader-empty' });
    empty.createEl('h2', { text: '小说阅读器' });
    empty.createEl('p', { text: '选择一本书开始阅读' });
    const btn = empty.createEl('button', { cls: 'novel-reader-pick', text: '选择书籍' });
    this.registerDomEvent(btn, 'click', () => {
      this.plugin.openPicker(this);
    });
  }
}

function listChapterFiles(folder: TFolder): TFile[] {
  const files = folder.children.filter(
    (c): c is TFile => c instanceof TFile && c.extension === 'md'
  );
  return files.sort((a, b) => naturalCompare(a.name, b.name));
}

/** 首次打开文件夹书：让用户勾选哪些文件算章节。 */
function pickChapters(app: App, folder: TFolder, files: TFile[]): Promise<TFile[]> {
  return new Promise((resolve) => {
    let done = false;
    const modal = new Modal(app);
    modal.titleEl.setText(`选择《${folder.name}》的章节`);
    const listEl = modal.contentEl.createDiv({ cls: 'nr-pick-list' });
    const checks: HTMLInputElement[] = [];
    for (const f of files) {
      const row = listEl.createDiv({ cls: 'nr-pick-item' });
      const cb = row.createEl('input', { type: 'checkbox' });
      cb.checked = chapterLike(f.name);
      checks.push(cb);
      row.createSpan({ text: f.name });
    }
    const actions = modal.contentEl.createDiv({ cls: 'nr-pick-actions' });
    const allBtn = actions.createEl('button', { cls: 'nr-btn', text: '全选' });
    allBtn.onclick = () => {
      checks.forEach((c) => (c.checked = true));
    };
    const noneBtn = actions.createEl('button', { cls: 'nr-btn', text: '全不选' });
    noneBtn.onclick = () => {
      checks.forEach((c) => (c.checked = false));
    };
    const okBtn = actions.createEl('button', { cls: 'nr-btn nr-btn-primary', text: '开始阅读' });
    okBtn.onclick = () => {
      modal.close();
    };
    modal.onClose = () => {
      if (!done) {
        done = true;
        resolve(files.filter((_, i) => checks[i].checked));
      }
    };
    modal.open();
  });
}

/* ---------------- 选书与目录弹窗 ---------------- */

/* ---------------- 搜索与书签弹窗 ---------------- */

type BookSource2 = {
  kind: 'bookmark';
  item: BookmarkItem;
};

type SearchSource = {
  kind: 'search';
  chapter: number;
  title: string;
  snippet: string;
  query: string;
};

type FindItem = BookSource2 | SearchSource;

/**
 * 输入为空时列出本书书签，有输入时对全书正文做子串匹配。
 */
class ReaderSearchModal extends FuzzySuggestModal<FindItem> {
  private readonly view: NovelReaderView;
  private readonly chapters: RenderChapter[];
  private readonly texts: string[];

  constructor(
    app: App,
    view: NovelReaderView,
    chapters: RenderChapter[],
    texts: string[]
  ) {
    super(app);
    this.view = view;
    this.chapters = chapters;
    this.texts = texts;
    this.setPlaceholder('搜索正文（留空查看书签）…');
  }

  public getItems(): FindItem[] {
    const query = this.inputEl.value.trim();
    if (query.length === 0) {
      const marks = this.view.getBookmarks();
      return marks.map((item) => ({ kind: 'bookmark', item }) as BookSource2);
    }
    const lower = query.toLowerCase();
    const out: FindItem[] = [];
    for (let i = 0; i < this.texts.length && out.length < 60; i++) {
      const hay = this.texts[i].toLowerCase();
      let pos = hay.indexOf(lower);
      while (pos >= 0 && out.length < 60) {
        const snippet = this.texts[i]
          .slice(Math.max(0, pos - 8), pos + query.length + 24)
          .replace(/\s+/g, ' ');
        out.push({
          kind: 'search',
          chapter: i,
          title: this.chapters[i].title,
          snippet,
          query,
        });
        pos = hay.indexOf(lower, pos + 1);
      }
    }
    return out;
  }

  public getItemText(item: FindItem): string {
    if (item.kind === 'bookmark') {
      return `★ ${item.item.excerpt}`;
    }
    return `${item.title} ${item.snippet}`;
  }

  public onChooseItem(item: FindItem): void {
    if (item.kind === 'bookmark') {
      void this.view.jumpToBookmark(item.item);
    } else {
      void this.view.jumpToChapterText(item.chapter, item.query);
    }
  }
}

/* ---------------- 书架 / 选书 / 搜索 ---------------- */

/** 书架：继续阅读 + 读过清单（带进度与移除）+ 浏览全库加书 */
class BookshelfModal extends Modal {
  private readonly plugin: NovelReaderPlugin;
  private readonly view: NovelReaderView;

  constructor(plugin: NovelReaderPlugin, view: NovelReaderView) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
  }

  public onOpen(): void {
    this.contentEl.addClass('nr-shelf');
    this.titleEl.setText('书架');

    const shelf = this.plugin.getShelf();
    const currentKey = this.view.hasSource ? this.view.sourceKey() : null;

    if (shelf.length === 0) {
      const hint = this.contentEl.createDiv({ cls: 'nr-shelf-hint' });
      hint.setText('书架还是空的，从下面浏览库添加一本书吧');
    } else {
      for (const entry of shelf) {
        const row = this.contentEl.createDiv({ cls: 'nr-shelf-item' });
        const main = row.createDiv({ cls: 'nr-shelf-main' });
        main.createDiv({ cls: 'nr-shelf-title', text: entry.title });
        main.createDiv({
          cls: 'nr-shelf-meta',
          text: `${entry.detail} · 已读 ${entry.overall}%${entry.key === currentKey ? ' · 正在阅读' : ''}`,
        });

        const openBtn = row.createEl('button', { cls: 'nr-btn', text: '打开' });
        openBtn.onclick = () => {
          const af = this.app.vault.getAbstractFileByPath(entry.key);
          if (af instanceof TFile) {
            void this.view.openSource({ kind: 'file', file: af });
          } else if (af instanceof TFolder) {
            void this.view.openSource({ kind: 'folder', folder: af });
          } else {
            new Notice('这本书已不在库中');
          }
          this.close();
        };

        const delBtn = row.createEl('button', { cls: 'nr-btn nr-btn-danger', text: '移除' });
        delBtn.onclick = () => {
          new ConfirmModal(this.app, '从书架移除', `移除《${entry.title}》的阅读记录、书签与章节配置？`, () => {
            this.plugin.removeFromShelf(entry.key);
            new Notice(`已移除《${entry.title}》`);
            if (this.view.hasSource && this.view.sourceKey() === entry.key) {
              void this.view.closeSource();
            }
            this.close();
          }).open();
        };
      }
    }

    const actions = this.contentEl.createDiv({ cls: 'nr-shelf-actions' });
    const browseBtn = actions.createEl('button', { cls: 'nr-btn nr-btn-primary', text: '浏览全库添加书籍' });
    browseBtn.onclick = () => {
      const targetView = this.view;
      this.close();
      new BookSuggester(this.plugin, targetView).open();
    };
  }
}

class ConfirmModal extends Modal {
  private readonly title: string;
  private readonly message: string;
  private readonly onConfirm: () => void;

  constructor(app: App, title: string, message: string, onConfirm: () => void) {
    super(app);
    this.title = title;
    this.message = message;
    this.onConfirm = onConfirm;
  }

  public onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createDiv({ cls: 'nr-confirm-text', text: this.message });
    const row = this.contentEl.createDiv({ cls: 'nr-pick-actions' });
    const cancel = row.createEl('button', { cls: 'nr-btn', text: '取消' });
    cancel.onclick = () => this.close();
    const ok = row.createEl('button', { cls: 'nr-btn nr-btn-danger', text: '确认移除' });
    ok.onclick = () => {
      this.onConfirm();
      this.close();
    };
  }
}

type PickItem =
  | { kind: 'file'; file: TFile }
  | { kind: 'folder'; folder: TFolder };

class BookSuggester extends FuzzySuggestModal<PickItem> {
  private readonly plugin: NovelReaderPlugin;
  private readonly view: NovelReaderView;

  constructor(plugin: NovelReaderPlugin, view: NovelReaderView) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
    this.setPlaceholder('浏览库添加书籍（根目录书籍与文件夹）…');
  }

  /** 只列根目录下的书籍，避免把设定表和杂物 md 混进来 */
  public getItems(): PickItem[] {
    const items: PickItem[] = [];
    for (const child of this.app.vault.getRoot().children) {
      if (child instanceof TFile && child.extension === 'md') {
        items.push({ kind: 'file', file: child });
      } else if (child instanceof TFolder && !child.name.startsWith('.') && folderHasMd(child)) {
        items.push({ kind: 'folder', folder: child });
      }
    }
    return items;
  }

  public getItemText(item: PickItem): string {
    const path = item.kind === 'file' ? item.file.path : item.folder.path;
    const name = item.kind === 'file' ? item.file.basename : item.folder.name;
    const stored = this.plugin.data.books[path];
    const prefix = stored ? `已读 ${stored.overall}% · ` : '';
    if (item.kind === 'file') {
      return `${prefix}${name} · 单文件`;
    }
    return `${prefix}${name} · 文件夹 · ${countMd(item.folder)} 篇`;
  }

  public onChooseItem(item: PickItem): void {
    if (item.kind === 'file') {
      void this.view.openSource({ kind: 'file', file: item.file });
    } else {
      void this.view.openSource({ kind: 'folder', folder: item.folder });
    }
  }
}

function countMd(folder: TFolder): number {
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md') {
      n += 1;
    } else if (child instanceof TFolder) {
      n += countMd(child);
    }
  }
  return n;
}

function folderHasMd(folder: TFolder): boolean {
  return countMd(folder) > 0;
}

class TocModal extends Modal {
  private readonly entries: TocEntry[];

  constructor(app: App, entries: TocEntry[]) {
    super(app);
    this.entries = entries;
  }

  public onOpen(): void {
    this.contentEl.addClass('nr-toc');
    this.titleEl.setText('目录');
    for (const entry of this.entries) {
      const btn = this.contentEl.createEl('button', {
        cls: `nr-toc-item nr-toc-l${Math.min(entry.level, 4)}`,
        text: entry.label,
      });
      btn.onclick = () => {
        entry.onClick();
        this.close();
      };
    }
  }
}
