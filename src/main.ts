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
}

export interface BookProgress {
  cid: number;
  percent: number;
}

export interface PluginData {
  settings: ReaderSettings;
  lastBook: string | null;
  books: Record<string, BookProgress>;
}

const DEFAULTS: PluginData = {
  settings: { fontSize: 17, lineHeight: 1.9, theme: 'auto' },
  lastBook: null,
  books: {},
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
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.scrollRaf) {
      window.cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
    }
  }

  public async openSource(src: BookSource): Promise<void> {
    this.source = src;
    this.plugin.data.lastBook = this.sourceKey();
    this.plugin.saveSoon();

    this.contentEl.empty();
    this.contentEl.addClass('novel-reader');
    this.buildShell();

    this.chapterFiles = src.kind === 'file' ? [src.file] : listChapterFiles(src.folder);

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
    mkBtn('目录', () => this.openToc());
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

  private showEmptyState(): void {
    this.source = null;
    this.chapterFiles = [];
    this.cidEls = [];
    this.pageCount = 1;
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
