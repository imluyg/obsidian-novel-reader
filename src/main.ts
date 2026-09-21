/**
 * Novel Reader — M1
 * 分页方案：CSS multi-column（column-fill: auto + 固定高），横向滚动按列翻页。
 * 进度 = 段落锚点（data-cid 序号）+ 全书百分比双保险，页码永不落盘。
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
  cid: number;
  percent: number;
}

export interface BookConfig {
  files: string[];
}

export interface PluginData {
  settings: ReaderSettings;
  lastBook: string | null;
  books: Record<string, BookProgress>;
  bookConfig: Record<string, BookConfig>;
}

const DEFAULTS: PluginData = {
  settings: { fontSize: 17, lineHeight: 1.9, theme: 'auto', immersive: true },
  lastBook: null,
  books: {},
  bookConfig: {},
};

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
    };

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

/** 章节名启发式：用于文件夹书首次打开时的默认勾选。无 lookbehind。 */
function chapterLike(name: string): boolean {
  if (/第.{0,4}[章節节卷回部集]/.test(name)) {
    return true;
  }
  if (/^\d+([._、\-\s]|\b)/.test(name)) {
    return true;
  }
  return /chapter/i.test(name);
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
  private chapterFiles: TFile[] = [];
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
          this.chapterFiles.some((c) => c.path === file.path);
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
          return;
        }
        const idx = this.chapterFiles.findIndex((c) => c.path === oldPath);
        if (idx >= 0 && file instanceof TFile) {
          this.chapterFiles[idx] = file;
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

    if (src.kind === 'folder') {
      const all = listChapterFiles(src.folder);
      if (all.length === 0) {
        new Notice('该文件夹没有 Markdown 文件');
        this.showEmptyState();
        return;
      }
      const cfg = this.plugin.data.bookConfig[src.folder.path];
      let files: TFile[];
      if (cfg && cfg.files.length > 0) {
        const wanted = new Set(cfg.files);
        files = all.filter((f) => wanted.has(f.name));
      } else {
        files = await pickChapters(this.app, src.folder, all);
        if (files.length === 0) {
          this.showEmptyState();
          return;
        }
        this.plugin.data.bookConfig[src.folder.path] = { files: files.map((f) => f.name) };
        this.plugin.saveSoon();
      }
      this.chapterFiles = files;
    } else {
      this.chapterFiles = [src.file];
    }

    this.contentEl.empty();
    this.contentEl.addClass('novel-reader');
    this.buildShell();

    this.cidEls = [];
    let cid = 0;
    for (const file of this.chapterFiles) {
      const chapterEl = this.pageEl!.createDiv({ cls: 'nr-chapter' });
      const text = await this.app.vault.cachedRead(file);
      await MarkdownRenderer.render(this.app, text, chapterEl, file.path, this);
      for (const el of Array.from(chapterEl.children)) {
        (el as HTMLElement).dataset.cid = String(cid++);
        this.cidEls.push(el as HTMLElement);
      }
    }

    this.applySettings();
    this.applyImmersive();
    this.ro = new ResizeObserver(() => {
      this.relayout(this.currentAnchor());
    });
    this.ro.observe(this.viewportEl!);

    const progress = this.plugin.data.books[this.sourceKey()];
    this.relayout(progress || { cid: 0, percent: 0 });
    this.saveProgressNow();
  }

  private sourceKey(): string {
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
    mkBtn('章节', () => this.repickChapters());
    mkBtn('换书', () => {
      this.toggleSheet(false);
      this.plugin.openPicker(this);
    });
  }

  private toggleSheet(force?: boolean): void {
    if (!this.sheetEl) {
      return;
    }
    const show = force !== undefined ? force : !this.sheetEl.hasClass('nr-open');
    this.sheetEl.toggleClass('nr-open', show);
  }

  private changeFont(delta: number): void {
    const s = this.plugin.data.settings;
    s.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, s.fontSize + delta));
    this.plugin.saveSoon();
    this.reflow();
  }

  /** 捏合过程中实时应用字号（rAF 节流重排，结束时机由 touchend 落盘） */
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

  private changeLineHeight(delta: number): void {
    const s = this.plugin.data.settings;
    s.lineHeight = Math.min(LH_MAX, Math.max(LH_MIN, Math.round((s.lineHeight + delta) * 10) / 10));
    this.plugin.saveSoon();
    this.reflow();
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

  private applySettings(): void {
    const s = this.plugin.data.settings;
    this.contentEl.style.setProperty('--nr-font', `${s.fontSize}px`);
    this.contentEl.style.setProperty('--nr-lh', String(s.lineHeight));
    if (this.themeBtnEl) {
      this.themeBtnEl.setText(this.themeLabel());
    }
    this.applyTheme();
  }

  private applyTheme(): void {
    const theme = this.plugin.data.settings.theme;
    this.contentEl.toggleClass('nr-sepia', theme === 'sepia');
    this.contentEl.toggleClass('nr-dark', theme === 'dark');
  }

  private reflow(): void {
    this.relayout(this.currentAnchor());
  }

  /** 重算分页并回到锚点（字号/行距/窗口尺寸变化后调用） */
  private relayout(anchor: BookProgress): void {
    if (!this.viewportEl || !this.pageEl) {
      return;
    }
    this.pageEl.style.columnWidth = `${this.viewportEl.clientWidth}px`;
    this.pageCount = Math.max(1, Math.ceil(this.pageEl.scrollWidth / this.stride()));
    this.restorePosition(anchor);
  }

  private stride(): number {
    return (this.viewportEl ? this.viewportEl.clientWidth : 0) + GAP;
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

  private restorePosition(anchor: BookProgress): void {
    if (!this.viewportEl || !this.pageEl) {
      return;
    }
    const el =
      anchor.cid >= 0 && anchor.cid < this.cidEls.length ? this.cidEls[anchor.cid] : undefined;
    if (el) {
      const col = Math.floor(this.contentX(el) / this.stride());
      this.viewportEl.scrollTo({ left: Math.max(0, col) * this.stride() });
    } else if (anchor.percent > 0) {
      const max = Math.max(1, this.pageEl.scrollWidth - this.viewportEl.clientWidth);
      this.viewportEl.scrollTo({ left: anchor.percent * max });
    }
    this.updateStatus();
  }

  private turnPage(dir: 1 | -1): void {
    if (!this.viewportEl) {
      return;
    }
    this.toggleSheet(false);
    const current = Math.round(this.viewportEl.scrollLeft / this.stride());
    const target = Math.min(this.pageCount - 1, Math.max(0, current + dir));
    this.viewportEl.scrollTo({ left: target * this.stride(), behavior: 'smooth' });
  }

  private currentAnchor(): BookProgress {
    if (!this.viewportEl || !this.pageEl) {
      return { cid: 0, percent: 0 };
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
    const max = Math.max(1, this.pageEl.scrollWidth - this.viewportEl.clientWidth);
    const percent = Math.min(1, Math.max(0, this.viewportEl.scrollLeft / max));
    return { cid, percent };
  }

  private saveProgressNow(): void {
    if (!this.source || !this.viewportEl || !this.pageEl) {
      return;
    }
    this.plugin.data.books[this.sourceKey()] = this.currentAnchor();
    this.plugin.saveSoon();
  }

  private updateStatus(): void {
    if (!this.statusEl || !this.viewportEl) {
      return;
    }
    const idx = Math.min(this.pageCount, Math.round(this.viewportEl.scrollLeft / this.stride()) + 1);
    const percent = Math.round((idx / this.pageCount) * 100);
    this.statusEl.setText(`${this.bookTitle()} · ${idx} / ${this.pageCount} 页 · ${percent}%`);
  }

  private openToc(): void {
    const entries: TocEntry[] = [];
    if (!this.source) {
      return;
    }
    if (this.source.kind === 'folder') {
      const chapterEls = this.pageEl ? Array.from(this.pageEl.children) : [];
      this.chapterFiles.forEach((file, i) => {
        const el = chapterEls[i] as HTMLElement | undefined;
        if (el) {
          entries.push({
            label: file.basename,
            level: 1,
            onClick: () => this.jumpToElement(el),
          });
        }
      });
    } else {
      const cache = this.app.metadataCache.getFileCache(this.source.file);
      const headings = (cache && cache.headings) || [];
      const headingEls = this.pageEl
        ? Array.from(this.pageEl.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        : [];
      if (headings.length === headingEls.length && headings.length > 0) {
        headings.forEach((h, i) => {
          entries.push({
            label: h.heading,
            level: h.level,
            onClick: () => this.jumpToElement(headingEls[i] as HTMLElement),
          });
        });
      } else {
        headingEls.forEach((el) => {
          entries.push({
            label: el.getText(),
            level: 1,
            onClick: () => this.jumpToElement(el as HTMLElement),
          });
        });
      }
    }
    if (entries.length === 0) {
      new Notice('本书没有可用的目录');
      return;
    }
    new TocModal(this.app, entries).open();
  }

  private jumpToElement(el: HTMLElement): void {
    if (!this.viewportEl) {
      return;
    }
    const col = Math.floor(this.contentX(el) / this.stride());
    this.viewportEl.scrollTo({ left: Math.max(0, col) * this.stride(), behavior: 'smooth' });
  }

  /** 文件夹书重新勾选章节 */
  private repickChapters(): void {
    if (!this.source || this.source.kind !== 'folder') {
      new Notice('只有文件夹书可以重新选择章节');
      return;
    }
    const folder = this.source.folder;
    delete this.plugin.data.bookConfig[folder.path];
    this.plugin.saveSoon();
    this.toggleSheet(false);
    void this.openSource({ kind: 'folder', folder });
  }

  private showEmptyState(): void {
    this.source = null;
    this.chapterFiles = [];
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
    const finish = (picked: TFile[]): void => {
      if (!done) {
        done = true;
        resolve(picked);
      }
    };
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
      finish(files.filter((_, i) => checks[i].checked));
    };
    modal.open();
  });
}

/* ---------------- 选书与目录弹窗 ---------------- */

type PickItem =
  | { kind: 'file'; file: TFile }
  | { kind: 'folder'; folder: TFolder };

class BookSuggester extends FuzzySuggestModal<PickItem> {
  private readonly view: NovelReaderView;

  constructor(plugin: NovelReaderPlugin, view: NovelReaderView) {
    super(plugin.app);
    this.view = view;
    this.setPlaceholder('搜索书名（文件或文件夹）…');
  }

  public getItems(): PickItem[] {
    const items: PickItem[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      items.push({ kind: 'file', file });
    }
    const walk = (folder: TFolder): void => {
      for (const child of folder.children) {
        if (child instanceof TFolder && !child.name.startsWith('.')) {
          const hasMd = child.children.some(
            (c): c is TFile => c instanceof TFile && c.extension === 'md'
          );
          if (hasMd) {
            items.push({ kind: 'folder', folder: child });
          }
          walk(child);
        }
      }
    };
    walk(this.app.vault.getRoot());
    return items;
  }

  public getItemText(item: PickItem): string {
    if (item.kind === 'file') {
      const parentPath = item.file.parent ? item.file.parent.path : '';
      return `${item.file.basename} ${parentPath}`;
    }
    return `${item.folder.name}（文件夹） ${item.folder.parent ? item.folder.parent.path : ''}`;
  }

  public onChooseItem(item: PickItem): void {
    if (item.kind === 'file') {
      void this.view.openSource({ kind: 'file', file: item.file });
    } else {
      void this.view.openSource({ kind: 'folder', folder: item.folder });
    }
  }
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
