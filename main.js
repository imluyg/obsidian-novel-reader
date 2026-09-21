"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NovelReaderView = exports.NOVEL_READER_VIEW_TYPE = void 0;
/**
 * Novel Reader — M3
 * 分页：CSS multi-column（column-fill: auto + 固定高），横向滚动按列翻页。
 * 渲染：按章按需渲染，DOM 中只保留当前章节；单文件大书按标题切成虚拟章。
 * 进度：（章节序号 + 段落锚点 + 章内页比例）三重冗余，页码永不落盘。
 * 移动端红线：不 import fs/path/electron；正则不使用 lookbehind；单文件构建。
 */
const obsidian_1 = require("obsidian");
exports.NOVEL_READER_VIEW_TYPE = 'novel-reader-view';
/** 单文件大书无标题时，按此字数切虚拟章（在段落边界断开） */
const CHUNK_SIZE = 8000;
const GAP = 48;
const FONT_MIN = 12;
const FONT_MAX = 30;
const LH_MIN = 1.4;
const LH_MAX = 2.6;
const DEFAULTS = {
    settings: { fontSize: 17, lineHeight: 1.9, theme: 'auto', immersive: true },
    lastBook: null,
    books: {},
    bookConfig: {},
};
/* ---------------- 插件入口 ---------------- */
class NovelReaderPlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.data = DEFAULTS;
        this.saveTimer = null;
    }
    async onload() {
        const loaded = await this.loadData();
        this.data = {
            settings: { ...DEFAULTS.settings, ...((loaded && loaded.settings) || {}) },
            lastBook: (loaded && loaded.lastBook) || null,
            books: (loaded && loaded.books) || {},
            bookConfig: (loaded && loaded.bookConfig) || {},
        };
        this.registerView(exports.NOVEL_READER_VIEW_TYPE, (leaf) => {
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
            checkCallback: (checking) => {
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
    onunload() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        void this.saveData(this.data);
    }
    saveSoon() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveData(this.data);
        }, 800);
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
        if (view instanceof NovelReaderView && !view.hasSource) {
            const last = this.data.lastBook;
            if (last) {
                const af = this.app.vault.getAbstractFileByPath(last);
                if (af instanceof obsidian_1.TFile) {
                    await view.openSource({ kind: 'file', file: af });
                    return;
                }
                if (af instanceof obsidian_1.TFolder) {
                    await view.openSource({ kind: 'folder', folder: af });
                    return;
                }
            }
            this.openPicker(view);
        }
    }
    openPicker(view) {
        new BookSuggester(this, view).open();
    }
    getActiveReaderView() {
        const leaves = this.app.workspace.getLeavesOfType(exports.NOVEL_READER_VIEW_TYPE);
        for (const leaf of leaves) {
            if (leaf.view instanceof NovelReaderView) {
                return leaf.view;
            }
        }
        return null;
    }
}
exports.default = NovelReaderPlugin;
/* ---------------- 工具 ---------------- */
/** 自然排序：`第2章` 排在 `第10章` 前面。无 lookbehind。 */
function naturalCompare(a, b) {
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
        }
        else {
            const cmp = as[i].localeCompare(bs[i]);
            if (cmp !== 0) {
                return cmp;
            }
        }
    }
    return as.length - bs.length;
}
function touchDistance(a, b) {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
}
/** 章节名启发式：文件夹书首次打开时的默认勾选。无 lookbehind。 */
function chapterLike(name) {
    if (/第.{0,4}[章節节卷回部集]/.test(name)) {
        return true;
    }
    if (/^\d+([._、\-\s]|\b)/.test(name)) {
        return true;
    }
    return /chapter/i.test(name);
}
/** 无标题的长文本按段落边界切成若干虚拟章 */
function splitByLength(text, size) {
    const out = [];
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
class NovelReaderView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.source = null;
        this.chapters = [];
        this.chapterIndex = 0;
        this.viewportEl = null;
        this.pageEl = null;
        this.statusEl = null;
        this.sheetEl = null;
        this.themeBtnEl = null;
        this.cidEls = [];
        this.pageCount = 1;
        this.ro = null;
        this.scrollRaf = 0;
        this.touchX = 0;
        this.touchY = 0;
        this.touchT = 0;
        this.pinchDist = 0;
        this.pinchFont = 0;
        this.suppressClick = false;
        this.pinchRaf = 0;
        this.plugin = plugin;
    }
    get hasSource() {
        return this.source !== null;
    }
    getViewType() {
        return exports.NOVEL_READER_VIEW_TYPE;
    }
    getDisplayText() {
        if (!this.source) {
            return '小说阅读器';
        }
        return this.source.kind === 'file' ? this.source.file.basename : this.source.folder.name;
    }
    getIcon() {
        return 'book-open';
    }
    async onOpen() {
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (!this.source) {
                return;
            }
            const gone = (this.source.kind === 'file' && this.source.file.path === file.path) ||
                (this.source.kind === 'folder' && this.source.folder.path === file.path) ||
                this.chapters.some((c) => c.file.path === file.path);
            if (gone) {
                this.showEmptyState();
            }
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!this.source) {
                return;
            }
            if (this.source.kind === 'file' && this.source.file.path === oldPath) {
                if (file instanceof obsidian_1.TFile) {
                    this.source = { kind: 'file', file };
                    this.chapters.forEach((c) => {
                        if (c.file.path === oldPath) {
                            c.file = file;
                        }
                    });
                }
                else {
                    this.showEmptyState();
                }
                return;
            }
            if (this.source.kind === 'folder' && this.source.folder.path === oldPath) {
                if (file instanceof obsidian_1.TFolder) {
                    this.source = { kind: 'folder', folder: file };
                }
                else {
                    this.showEmptyState();
                }
            }
        }));
        this.showEmptyState();
    }
    async onClose() {
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
    async openSource(src) {
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
            new obsidian_1.Notice('这本书没有可渲染的内容');
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
        this.ro.observe(this.viewportEl);
        const progress = this.plugin.data.books[this.sourceKey()];
        const index = progress
            ? Math.min(this.chapters.length - 1, Math.max(0, progress.chapter))
            : 0;
        const target = progress
            ? { cid: progress.cid, percent: progress.percent }
            : { page: 0 };
        await this.loadChapter(index, target);
    }
    /** 文件夹书：按已保存的章节配置过滤，首次打开弹勾选框 */
    async resolveFolderChapters(folder) {
        const all = listChapterFiles(folder);
        if (all.length === 0) {
            new obsidian_1.Notice('该文件夹没有 Markdown 文件');
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
    async buildChapters(files) {
        const chapters = [];
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
    sourceKey() {
        if (!this.source) {
            return '';
        }
        return this.source.kind === 'file' ? this.source.file.path : this.source.folder.path;
    }
    bookTitle() {
        if (!this.source) {
            return '';
        }
        return this.source.kind === 'file' ? this.source.file.basename : this.source.folder.name;
    }
    /* ---------- 界面骨架与交互 ---------- */
    buildShell() {
        this.viewportEl = this.contentEl.createDiv({ cls: 'novel-reader-viewport' });
        this.pageEl = this.viewportEl.createDiv({ cls: 'nr-page' });
        const overlay = this.contentEl.createDiv({ cls: 'nr-overlay' });
        this.registerDomEvent(overlay, 'click', (evt) => {
            if (this.suppressClick) {
                this.suppressClick = false;
                return;
            }
            const rect = overlay.getBoundingClientRect();
            const x = evt.clientX - rect.left;
            if (x < rect.width * 0.25) {
                this.turnPage(-1);
            }
            else if (x > rect.width * 0.75) {
                this.turnPage(1);
            }
            else {
                this.toggleSheet();
            }
        });
        // 滑动翻页（单指横滑）+ 捏合缩放（双指）
        this.registerDomEvent(overlay, 'touchstart', (evt) => {
            if (evt.touches.length === 1) {
                this.touchX = evt.touches[0].clientX;
                this.touchY = evt.touches[0].clientY;
                this.touchT = Date.now();
            }
            else if (evt.touches.length === 2) {
                this.pinchDist = touchDistance(evt.touches[0], evt.touches[1]);
                this.pinchFont = this.plugin.data.settings.fontSize;
            }
        }, { passive: true });
        this.registerDomEvent(overlay, 'touchmove', (evt) => {
            if (evt.touches.length === 2 && this.pinchDist > 0) {
                evt.preventDefault();
                const dist = touchDistance(evt.touches[0], evt.touches[1]);
                const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round((this.pinchFont * dist) / this.pinchDist)));
                this.suppressClick = true;
                this.applyFontSizeLive(next);
            }
        }, { passive: false });
        this.registerDomEvent(overlay, 'touchend', (evt) => {
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
        }, { passive: true });
        // 桌面端触控板横滑 / 键盘翻页
        this.registerDomEvent(overlay, 'wheel', (evt) => {
            if (Math.abs(evt.deltaX) > Math.abs(evt.deltaY)) {
                evt.preventDefault();
                this.turnPage(evt.deltaX > 0 ? 1 : -1);
            }
        }, { passive: false });
        this.containerEl.tabIndex = 0;
        this.registerDomEvent(this.containerEl, 'keydown', (evt) => {
            if (evt.key === 'ArrowRight' || evt.key === 'PageDown' || evt.key === ' ') {
                evt.preventDefault();
                this.turnPage(1);
            }
            else if (evt.key === 'ArrowLeft' || evt.key === 'PageUp') {
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
    buildSheet() {
        this.sheetEl = this.contentEl.createDiv({ cls: 'nr-sheet' });
        const row = this.sheetEl.createDiv({ cls: 'nr-sheet-row' });
        const mkBtn = (label, onClick) => {
            const btn = row.createEl('button', { cls: 'nr-btn', text: label });
            this.registerDomEvent(btn, 'click', (evt) => {
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
        mkBtn('换书', () => {
            this.toggleSheet(false);
            this.plugin.openPicker(this);
        });
    }
    toggleSheet(force) {
        if (!this.sheetEl) {
            return;
        }
        const show = force !== undefined ? force : !this.sheetEl.hasClass('nr-open');
        this.sheetEl.toggleClass('nr-open', show);
    }
    /* ---------- 排版与主题 ---------- */
    changeFont(delta) {
        const s = this.plugin.data.settings;
        s.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, s.fontSize + delta));
        this.plugin.saveSoon();
        this.reflow();
    }
    changeLineHeight(delta) {
        const s = this.plugin.data.settings;
        s.lineHeight = Math.min(LH_MAX, Math.max(LH_MIN, Math.round((s.lineHeight + delta) * 10) / 10));
        this.plugin.saveSoon();
        this.reflow();
    }
    /** 捏合过程中实时应用字号（rAF 节流重排，抬手时才落盘） */
    applyFontSizeLive(size) {
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
    cycleTheme() {
        const order = ['auto', 'sepia', 'dark'];
        const s = this.plugin.data.settings;
        s.theme = order[(order.indexOf(s.theme) + 1) % order.length];
        this.plugin.saveSoon();
        if (this.themeBtnEl) {
            this.themeBtnEl.setText(this.themeLabel());
        }
        this.applyTheme();
    }
    themeLabel() {
        const t = this.plugin.data.settings.theme;
        return t === 'auto' ? '跟随主题' : t === 'sepia' ? '米色' : '暗黑';
    }
    immersiveLabel() {
        return this.plugin.data.settings.immersive ? '沉浸开' : '沉浸关';
    }
    toggleImmersive() {
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
    applyImmersive() {
        document.body.toggleClass('nr-immersive', this.plugin.data.settings.immersive && !!this.source);
    }
    applyTheme() {
        const theme = this.plugin.data.settings.theme;
        this.contentEl.toggleClass('nr-sepia', theme === 'sepia');
        this.contentEl.toggleClass('nr-dark', theme === 'dark');
    }
    applySettings() {
        const s = this.plugin.data.settings;
        this.contentEl.style.setProperty('--nr-font', `${s.fontSize}px`);
        this.contentEl.style.setProperty('--nr-lh', String(s.lineHeight));
        if (this.themeBtnEl) {
            this.themeBtnEl.setText(this.themeLabel());
        }
        this.applyTheme();
    }
    /* ---------- 章节渲染与分页 ---------- */
    async loadChapter(index, target) {
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
        await obsidian_1.MarkdownRenderer.render(this.app, md, holder, chapter.file.path, this);
        this.cidEls = [];
        let cid = 0;
        for (const el of Array.from(holder.children)) {
            el.dataset.cid = String(cid++);
            this.cidEls.push(el);
        }
        this.relayout(undefined, target);
        this.saveProgressNow();
    }
    reflow() {
        this.relayout(this.currentAnchor());
    }
    /** 重算分页并定位：anchor 用于重排（保持当前位置），target 用于章节加载后的跳转 */
    relayout(anchor, target) {
        if (!this.viewportEl || !this.pageEl) {
            return;
        }
        this.pageEl.style.columnWidth = `${this.viewportEl.clientWidth}px`;
        this.pageCount = Math.max(1, Math.ceil(this.pageEl.scrollWidth / this.stride()));
        if (target) {
            this.restoreTarget(target);
        }
        else if (anchor) {
            this.restoreAnchor(anchor);
        }
        this.updateStatus();
    }
    restoreAnchor(anchor) {
        if (!this.viewportEl) {
            return;
        }
        const el = anchor.cid >= 0 && anchor.cid < this.cidEls.length ? this.cidEls[anchor.cid] : undefined;
        if (el) {
            const col = Math.floor(this.contentX(el) / this.stride());
            this.viewportEl.scrollTo({ left: Math.max(0, col) * this.stride() });
            return;
        }
        this.viewportEl.scrollTo({ left: anchor.percent * this.maxScroll() });
    }
    restoreTarget(target) {
        if (!this.viewportEl) {
            return;
        }
        if (target.last) {
            this.viewportEl.scrollTo({ left: (this.pageCount - 1) * this.stride() });
            return;
        }
        const el = target.cid !== undefined && target.cid >= 0 && target.cid < this.cidEls.length
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
    stride() {
        return (this.viewportEl ? this.viewportEl.clientWidth : 0) + GAP;
    }
    maxScroll() {
        if (!this.viewportEl || !this.pageEl) {
            return 1;
        }
        return Math.max(1, this.pageEl.scrollWidth - this.viewportEl.clientWidth);
    }
    contentX(el) {
        if (!this.viewportEl || !this.pageEl) {
            return 0;
        }
        return (el.getBoundingClientRect().left +
            this.viewportEl.scrollLeft -
            this.pageEl.getBoundingClientRect().left);
    }
    currentPageIndex() {
        if (!this.viewportEl) {
            return 0;
        }
        return Math.max(0, Math.round(this.viewportEl.scrollLeft / this.stride()));
    }
    turnPage(dir) {
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
    currentAnchor() {
        if (!this.viewportEl) {
            return { chapter: this.chapterIndex, cid: 0, percent: 0 };
        }
        const edge = this.viewportEl.scrollLeft + 2;
        let cid = 0;
        for (let i = 0; i < this.cidEls.length; i++) {
            if (this.contentX(this.cidEls[i]) <= edge) {
                cid = i;
            }
            else {
                break;
            }
        }
        const percent = Math.min(1, Math.max(0, this.viewportEl.scrollLeft / this.maxScroll()));
        return { chapter: this.chapterIndex, cid, percent };
    }
    saveProgressNow() {
        if (!this.source || !this.viewportEl) {
            return;
        }
        this.plugin.data.books[this.sourceKey()] = this.currentAnchor();
        this.plugin.saveSoon();
    }
    updateStatus() {
        if (!this.statusEl) {
            return;
        }
        const page = Math.min(this.pageCount, this.currentPageIndex() + 1);
        const totalChapters = Math.max(1, this.chapters.length);
        const overall = Math.round(((this.chapterIndex + page / this.pageCount) / totalChapters) * 100);
        this.statusEl.setText(`${this.bookTitle()} · 第 ${this.chapterIndex + 1}/${totalChapters} 章 · ${page}/${this.pageCount} 页 · ${overall}%`);
    }
    openToc() {
        if (this.chapters.length === 0) {
            return;
        }
        const entries = this.chapters.map((chapter, i) => ({
            label: chapter.title,
            level: chapter.level,
            onClick: () => void this.loadChapter(i, { page: 0 }),
        }));
        this.toggleSheet(false);
        new TocModal(this.app, entries).open();
    }
    showEmptyState() {
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
exports.NovelReaderView = NovelReaderView;
function listChapterFiles(folder) {
    const files = folder.children.filter((c) => c instanceof obsidian_1.TFile && c.extension === 'md');
    return files.sort((a, b) => naturalCompare(a.name, b.name));
}
/** 首次打开文件夹书：让用户勾选哪些文件算章节。 */
function pickChapters(app, folder, files) {
    return new Promise((resolve) => {
        let done = false;
        const modal = new obsidian_1.Modal(app);
        modal.titleEl.setText(`选择《${folder.name}》的章节`);
        const listEl = modal.contentEl.createDiv({ cls: 'nr-pick-list' });
        const checks = [];
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
class BookSuggester extends obsidian_1.FuzzySuggestModal {
    constructor(plugin, view) {
        super(plugin.app);
        this.view = view;
        this.setPlaceholder('搜索书名（文件或文件夹）…');
    }
    getItems() {
        const items = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            items.push({ kind: 'file', file });
        }
        const walk = (folder) => {
            for (const child of folder.children) {
                if (child instanceof obsidian_1.TFolder && !child.name.startsWith('.')) {
                    const hasMd = child.children.some((c) => c instanceof obsidian_1.TFile && c.extension === 'md');
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
    getItemText(item) {
        if (item.kind === 'file') {
            const parentPath = item.file.parent ? item.file.parent.path : '';
            return `${item.file.basename} ${parentPath}`;
        }
        return `${item.folder.name}（文件夹） ${item.folder.parent ? item.folder.parent.path : ''}`;
    }
    onChooseItem(item) {
        if (item.kind === 'file') {
            void this.view.openSource({ kind: 'file', file: item.file });
        }
        else {
            void this.view.openSource({ kind: 'folder', folder: item.folder });
        }
    }
}
class TocModal extends obsidian_1.Modal {
    constructor(app, entries) {
        super(app);
        this.entries = entries;
    }
    onOpen() {
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
