"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOVEL_READER_VIEW_TYPE = void 0;
/**
 * Novel Reader — M0 骨架
 * 移动端红线：不 import fs/path/electron；正则不使用 lookbehind。
 * 数据源：vault.cachedRead / metadataCache；进度与配置走 saveData。
 */
const obsidian_1 = require("obsidian");
exports.NOVEL_READER_VIEW_TYPE = 'novel-reader-view';
class NovelReaderPlugin extends obsidian_1.Plugin {
    async onload() {
        this.registerView(exports.NOVEL_READER_VIEW_TYPE, (leaf) => {
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
            checkCallback: (checking) => {
                const app = this.app;
                if (typeof app.emulateMobile !== 'function') {
                    return false;
                }
                if (!checking) {
                    const target = !app.isMobile;
                    app.emulateMobile(target);
                    new obsidian_1.Notice(target ? '已切换到移动端模拟' : '已切回桌面模式');
                }
                return true;
            },
        });
    }
    async openReader() {
        const { workspace } = this.app;
        let leaf = null;
        const existing = workspace.getLeavesOfType(exports.NOVEL_READER_VIEW_TYPE);
        if (existing.length > 0) {
            leaf = existing[0];
        }
        else {
            leaf = workspace.getLeaf(false);
            await leaf.setViewState({
                type: exports.NOVEL_READER_VIEW_TYPE,
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
exports.default = NovelReaderPlugin;
class NovelReaderView extends obsidian_1.ItemView {
    constructor(leaf) {
        super(leaf);
        this.currentFile = null;
    }
    getViewType() {
        return exports.NOVEL_READER_VIEW_TYPE;
    }
    getDisplayText() {
        return this.currentFile ? this.currentFile.basename : '小说阅读器';
    }
    getIcon() {
        return 'book-open';
    }
    async onOpen() {
        // 书被删除/重命名时回到空状态
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file === this.currentFile) {
                this.showEmptyState();
            }
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (oldPath === (this.currentFile && this.currentFile.path)) {
                if (file instanceof obsidian_1.TFile) {
                    this.currentFile = file;
                }
                else {
                    this.showEmptyState();
                }
            }
        }));
        this.showEmptyState();
    }
    async openBook(file) {
        this.currentFile = file;
        this.contentEl.empty();
        this.contentEl.addClass('novel-reader');
        const content = this.contentEl.createDiv({ cls: 'novel-reader-content' });
        const text = await this.app.vault.cachedRead(file);
        await obsidian_1.MarkdownRenderer.render(this.app, text, content, file.path, this);
        const charCount = text.replace(/\s/g, '').length;
        const meta = content.createDiv({ cls: 'novel-reader-meta', text: `${file.basename} · 约 ${charCount} 字` });
        content.insertBefore(meta, content.firstChild);
    }
    showEmptyState() {
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
class BookSuggester extends obsidian_1.FuzzySuggestModal {
    constructor(app, view) {
        super(app);
        this.view = view;
        this.setPlaceholder('搜索书名或路径…');
    }
    getItems() {
        return this.app.vault.getMarkdownFiles();
    }
    getItemText(item) {
        return `${item.basename} ${item.parent ? item.parent.path : ''}`;
    }
    onChooseItem(item) {
        void this.view.openBook(item);
    }
}
