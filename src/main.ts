/**
 * Novel Reader — M0 骨架
 * 移动端红线：不 import fs/path/electron；正则不使用 lookbehind。
 * 数据源：vault.cachedRead / metadataCache；进度与配置走 saveData。
 */
import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';

export const NOVEL_READER_VIEW_TYPE = 'novel-reader-view';

export default class NovelReaderPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(NOVEL_READER_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
      return new NovelReaderView(leaf);
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

    // 调试用：桌面端一键切换移动端模拟（内部 API，版本升级可能变化）
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

  private async openReader(): Promise<void> {
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
    if (view instanceof NovelReaderView && !view.currentFile) {
      new BookSuggester(this.app, view).open();
    }
  }
}

class NovelReaderView extends ItemView {
  public currentFile: TFile | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  public getViewType(): string {
    return NOVEL_READER_VIEW_TYPE;
  }

  public getDisplayText(): string {
    return this.currentFile ? this.currentFile.basename : '小说阅读器';
  }

  public getIcon(): string {
    return 'book-open';
  }

  public async onOpen(): Promise<void> {
    // 书被删除/重命名时回到空状态
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file === this.currentFile) {
          this.showEmptyState();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (oldPath === (this.currentFile && this.currentFile.path)) {
          if (file instanceof TFile) {
            this.currentFile = file;
          } else {
            this.showEmptyState();
          }
        }
      })
    );
    this.showEmptyState();
  }

  public async openBook(file: TFile): Promise<void> {
    this.currentFile = file;
    this.contentEl.empty();
    this.contentEl.addClass('novel-reader');

    const content = this.contentEl.createDiv({ cls: 'novel-reader-content' });
    const text = await this.app.vault.cachedRead(file);
    await MarkdownRenderer.render(this.app, text, content, file.path, this);

    const charCount = text.replace(/\s/g, '').length;
    const meta = content.createDiv({ cls: 'novel-reader-meta', text: `${file.basename} · 约 ${charCount} 字` });
    content.insertBefore(meta, content.firstChild);
  }

  private showEmptyState(): void {
    this.currentFile = null;
    this.contentEl.empty();
    this.contentEl.addClass('novel-reader');
    const empty = this.contentEl.createDiv({ cls: 'novel-reader-empty' });
    empty.createEl('h2', { text: '小说阅读器' });
    empty.createEl('p', { text: '选择一本书开始阅读' });
    const btn = empty.createEl('button', { cls: 'novel-reader-pick', text: '选择书籍' });
    this.registerDomEvent(btn, 'click', () => {
      new BookSuggester(this.app, this).open();
    });
  }
}

class BookSuggester extends FuzzySuggestModal<TFile> {
  private readonly view: NovelReaderView;

  constructor(app: App, view: NovelReaderView) {
    super(app);
    this.view = view;
    this.setPlaceholder('搜索书名或路径…');
  }

  public getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  public getItemText(item: TFile): string {
    return `${item.basename} ${item.parent ? item.parent.path : ''}`;
  }

  public onChooseItem(item: TFile): void {
    void this.view.openBook(item);
  }
}
