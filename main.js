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
/** 单章字数上限：再长就在段落边界补切一刀，避免一章的 DOM 太大拖慢排版 */
const CHAPTER_MAX_CHARS = 24000;
/** 短于这个长度的"章"视为连续标题行（「第一卷」「第一章」紧挨着），合并掉 */
const MIN_CHAPTER_CHARS = 300;
/** 目录弹窗一次渲染多少条，超出的点「显示更多」追加（大书可能有上千章） */
const TOC_PAGE = 300;
const GAP = 48;
const FONT_MIN = 12;
const FONT_MAX = 30;
const LH_MIN = 1.4;
const LH_MAX = 2.6;
const DEFAULTS = {
    settings: {
        fontSize: 17,
        lineHeight: 1.9,
        theme: 'auto',
        immersive: true,
        perBookTypography: true,
        deepBrowse: true,
    },
    lastBook: null,
    books: {},
    bookConfig: {},
    bookmarks: {},
    bookStyle: {},
};
/** 兼容旧版本（v0.3.0 及以前）的进度结构：缺 chapter 字段时兜底为第 0 章 */
function normalizeProgress(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const rec = raw;
    const num = (v, fallback) => {
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
            bookmarks: (loaded && loaded.bookmarks) || {},
            bookStyle: (loaded && loaded.bookStyle) || {},
        };
        // 把历史数据（可能缺 chapter 字段）统一规范化，避免老版本升级后定位异常
        for (const key of Object.keys(this.data.books)) {
            const fixed = normalizeProgress(this.data.books[key]);
            if (fixed) {
                this.data.books[key] = fixed;
            }
            else {
                delete this.data.books[key];
            }
        }
        this.registerView(exports.NOVEL_READER_VIEW_TYPE, (leaf) => {
            return new NovelReaderView(leaf, this);
        });
        // 阅读器没打开时也要维护书籍数据：在文件树里改名/删掉一本书不该让进度凭空消失
        // （视图打开着的情形由视图自己处理，这里跳过，避免重复迁移）
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (this.readerViews().some((v) => v.handlesPath(oldPath))) {
                return;
            }
            this.remapBookRecord(oldPath, file.path);
            const parent = file.parent;
            if (parent && this.data.bookConfig[parent.path]) {
                this.remapChapterPath(parent.path, oldPath, file.path);
            }
            this.saveSoon();
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            const path = file.path;
            if (this.readerViews().some((v) => v.handlesPath(path))) {
                return;
            }
            if (this.data.books[path] ||
                this.data.bookmarks[path] ||
                this.data.bookConfig[path] ||
                this.data.bookStyle[path]) {
                this.removeFromShelf(path);
            }
        }));
        this.addSettingTab(new NovelReaderSettingTab(this.app, this));
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
            id: 'open-book-shelf',
            name: '打开书架',
            checkCallback: (checking) => {
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
    /** 书架：已读过（有进度记录）且仍存在的书，按最近阅读排序 */
    getShelf() {
        const entries = [];
        for (const key of Object.keys(this.data.books)) {
            const af = this.app.vault.getAbstractFileByPath(key);
            const progress = this.data.books[key];
            if (af instanceof obsidian_1.TFolder) {
                entries.push({
                    key,
                    kind: 'folder',
                    title: af.name,
                    detail: `文件夹 · ${countMd(af)} 篇`,
                    overall: progress.overall,
                    updatedAt: progress.updatedAt,
                });
            }
            else if (af instanceof obsidian_1.TFile) {
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
    removeFromShelf(key) {
        delete this.data.books[key];
        delete this.data.bookmarks[key];
        delete this.data.bookConfig[key];
        delete this.data.bookStyle[key];
        if (this.data.lastBook === key) {
            this.data.lastBook = null;
        }
        this.saveSoon();
    }
    /** 文件/文件夹改名后迁移进度、书签与章节配置，避免阅读记录丢失 */
    remapBookRecord(oldPath, newPath) {
        if (!oldPath || oldPath === newPath) {
            return;
        }
        const d = this.data;
        if (d.books[oldPath]) {
            d.books[newPath] = d.books[oldPath];
            delete d.books[oldPath];
        }
        if (d.bookmarks[oldPath]) {
            d.bookmarks[newPath] = d.bookmarks[oldPath];
            delete d.bookmarks[oldPath];
        }
        if (d.bookConfig[oldPath]) {
            d.bookConfig[newPath] = d.bookConfig[oldPath];
            delete d.bookConfig[oldPath];
        }
        if (d.bookStyle[oldPath]) {
            d.bookStyle[newPath] = d.bookStyle[oldPath];
            delete d.bookStyle[oldPath];
        }
        if (d.lastBook === oldPath) {
            d.lastBook = newPath;
        }
        this.saveSoon();
    }
    /** 文件夹书内部某个 md 改名后，同步更新已保存的章节配置 */
    remapChapterPath(folderPath, oldPath, newPath) {
        const cfg = this.data.bookConfig[folderPath];
        if (!cfg) {
            return;
        }
        const prefix = folderPath + '/';
        const oldRel = oldPath.startsWith(prefix) ? oldPath.slice(prefix.length) : oldPath;
        const newRel = newPath.startsWith(prefix) ? newPath.slice(prefix.length) : newPath;
        const i = cfg.files.indexOf(oldRel);
        if (i >= 0) {
            cfg.files[i] = newRel;
            this.saveSoon();
        }
    }
    /** 设置面板改动排版：开了「每本书独立」就只作用于当前这本书，否则改全局默认 */
    applyTypography(patch) {
        const view = this.getActiveReaderView();
        if (view && view.hasSource && this.data.settings.perBookTypography) {
            view.setTypography(patch);
            view.refreshTypography();
            return;
        }
        const s = this.data.settings;
        if (patch.fontSize !== undefined) {
            s.fontSize = patch.fontSize;
        }
        if (patch.lineHeight !== undefined) {
            s.lineHeight = patch.lineHeight;
        }
        if (patch.theme !== undefined) {
            s.theme = patch.theme;
        }
        this.saveSoon();
        this.refreshReaderViews();
    }
    /** 清掉某本书的独立排版记忆，不传 key 则全部清空 */
    clearBookStyle(key) {
        if (key) {
            delete this.data.bookStyle[key];
        }
        else {
            this.data.bookStyle = {};
        }
        this.saveSoon();
        this.refreshReaderViews();
    }
    /** 让已打开的阅读器按当前设置重排 */
    refreshReaderViews() {
        for (const view of this.readerViews()) {
            view.refreshTypography();
        }
    }
    /** 所有已打开的阅读器视图 */
    readerViews() {
        const out = [];
        for (const leaf of this.app.workspace.getLeavesOfType(exports.NOVEL_READER_VIEW_TYPE)) {
            if (leaf.view instanceof NovelReaderView) {
                out.push(leaf.view);
            }
        }
        return out;
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
/**
 * metadataCache 的 offset 以完整文件为基准；cachedRead 返回的文本是否还带着
 * frontmatter 在官方 API 里没写死。这里用第一个标题做一次探测，自动对齐基准，
 * 避免有 frontmatter 的书整体串章。探测失败时退回 0（保持原有行为）。
 */
function resolveOffsetBase(text, headings, fmEnd) {
    if (headings.length === 0) {
        return 0;
    }
    const probe = headings[0].heading.trim();
    if (!probe) {
        return 0;
    }
    const raw = headings[0].position.start.offset;
    for (const base of fmEnd > 0 ? [0, fmEnd] : [0]) {
        const start = raw - base;
        if (start < 0 || start >= text.length) {
            continue;
        }
        if (text.slice(start, start + probe.length + 10).includes(probe)) {
            return base;
        }
    }
    return 0;
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
/**
 * 网文爬站体小说：整篇每行都缩进（4 空格或全角空格），且一个 markdown 标题都没有。
 * 行首缩进必须去掉——markdown 里 4 空格缩进 = 代码块，几百万字会被渲染成一个不换行的
 * <pre>，横向撑爆 multi-column，分页和滚动全乱。同时顺手统一换行、压掉连续空行。
 * 注意：只在没有 metadataCache headings 时才用，否则会破坏 heading offset。
 */
function normalizePlainNovel(raw) {
    return raw
        .replace(/\r\n?/g, '\n')
        .replace(/^[ \t\u3000]+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/** 「第一章」「第 12 节」「Chapter 3」「Vol.2」这类纯文本章节行 */
const CHAPTER_LINE_SOURCE = '(?:^|\\n)([ \\t\\u3000]*)(第[0-9零一二三四五六七八九十百千万两]{1,12}[章节節回卷篇集部]|chapter\\s*\\d+|vol\\.?\\s*\\d+)';
function isChapterLine(line) {
    return (/^第[0-9零一二三四五六七八九十百千万两]{1,12}[章节節回卷篇集部]/.test(line) ||
        /^(chapter\s*\d+|vol\.?\s*\d+)/i.test(line));
}
/**
 * 按「第 N 章」这类纯文本标题行切章（大书靠这个保住章节结构，而不是按字数乱切）。
 * 切出来过长的章再按段落边界细分；识别不到（少于 2 处）返回空数组，由调用方退回按字数切。
 */
function splitNovelChapters(text, basename, maxChars) {
    const marks = [];
    const re = new RegExp(CHAPTER_LINE_SOURCE, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
        // m[1] = 行首缩进，m[2] = 匹配到的章节关键词
        const offset = m.index + m[0].length - m[1].length - m[2].length;
        let nl = text.indexOf('\n', offset);
        if (nl < 0) {
            nl = text.length;
        }
        const title = text.slice(offset, Math.min(nl, offset + 40)).trim();
        marks.push({ offset, title: title || m[2] });
        if (marks.length >= 20000) {
            break;
        }
    }
    // 「第一卷」「第一章」这类紧挨着的连续标题行（还有缩进重复一次的同名行）
    // 会切出只有几个字的空章，这里按最小长度合并，后一条更具体就替换掉前一条
    const kept = [];
    for (const mark of marks) {
        const prev = kept[kept.length - 1];
        if (prev && mark.offset - prev.offset < MIN_CHAPTER_CHARS) {
            kept[kept.length - 1] = mark;
            continue;
        }
        kept.push(mark);
    }
    if (kept.length < 2) {
        return [];
    }
    const out = [];
    const pushRange = (start, end, title) => {
        if (end <= start) {
            return;
        }
        if (end - start <= maxChars) {
            out.push({ title, start, end });
            return;
        }
        let s = start;
        let part = 1;
        while (end - s > maxChars) {
            const tail = text.slice(s, s + maxChars);
            const cut = Math.max(tail.lastIndexOf('\n\n'), tail.lastIndexOf('\n'));
            const e = cut > maxChars * 0.4 ? s + cut + 1 : s + maxChars;
            out.push({ title: `${title} · ${part}`, start: s, end: e });
            s = e;
            part += 1;
        }
        out.push({ title: `${title} · ${part}`, start: s, end });
    };
    if (kept[0].offset > 0) {
        if (kept[0].offset < MIN_CHAPTER_CHARS) {
            // 开篇太短（书名/作者/卷名几行），并进第一章，别单独占一个空章
            kept[0] = { offset: 0, title: kept[0].title };
        }
        else {
            pushRange(0, kept[0].offset, `${basename} · 开篇`);
        }
    }
    for (let i = 0; i < kept.length; i++) {
        const end = i + 1 < kept.length ? kept[i + 1].offset : text.length;
        pushRange(kept[i].offset, end, kept[i].title);
    }
    return out;
}
class NovelReaderView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.source = null;
        /** 打开时记录的书路径：TFile/TFolder 实例会被 Obsidian 就地改名，不能直接拿来比对旧路径 */
        this.openPath = '';
        this.chapters = [];
        this.chapterIndex = 0;
        this.viewportEl = null;
        this.pageEl = null;
        this.statusEl = null;
        this.sheetEl = null;
        this.themeBtnEl = null;
        this.cidEls = [];
        /** chapters 每次重建都自增，用来作废还在跑的搜索索引构建 */
        this.chaptersVersion = 0;
        this.indexVersion = -1;
        this.chapterTexts = [];
        this.pageCount = 1;
        this.ro = null;
        this.scrollRaf = 0;
        /** 平滑翻页进行中的目标页，用于避免连点时读取中间 scrollLeft 造成丢页 */
        this.pendingPage = 0;
        /** 平滑翻页动画的预期结束时间（epoch ms） */
        this.pendingExpire = 0;
        /** 源文件被改动后的重渲染防抖 */
        this.modifyTimer = null;
        this.touchX = 0;
        this.touchY = 0;
        this.touchT = 0;
        this.pinchDist = 0;
        this.pinchFont = 0;
        this.suppressClick = false;
        this.pinchRaf = 0;
        /** 单文件大书的整本正文缓存：切章只记偏移量，翻章时按需 slice，避免反复读/复制全文 */
        this.bookText = null;
        /** 纯文本小说（网文爬站体）：不走 MarkdownRenderer，直接按行生成段落 */
        this.plainText = false;
        this.plugin = plugin;
    }
    get hasSource() {
        return this.source !== null;
    }
    /** 这本书是否正由本视图打开（插件级 vault 事件用它避免重复处理） */
    handlesPath(path) {
        return this.openPath === path;
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
            if (this.openPath === file.path) {
                this.showEmptyState();
                return;
            }
            if (this.source.kind === 'file') {
                if (this.source.file.path === file.path) {
                    this.showEmptyState();
                }
                return;
            }
            // 文件夹书里少了一个章节文件：重新载入，不整本关掉
            if (this.chapters.some((c) => c.file.path === file.path)) {
                void this.openSource(this.source);
            }
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!this.source) {
                return;
            }
            // 章节 md 改名：同步文件夹书已保存的章节配置
            if (this.source.kind === 'folder') {
                this.plugin.remapChapterPath(this.source.folder.path, oldPath, file.path);
            }
            if (oldPath !== this.openPath) {
                return;
            }
            this.openPath = file.path;
            if (this.source.kind === 'file' && file instanceof obsidian_1.TFile) {
                this.source = { kind: 'file', file };
            }
            else if (this.source.kind === 'folder' && file instanceof obsidian_1.TFolder) {
                this.source = { kind: 'folder', folder: file };
            }
            else {
                this.showEmptyState();
                return;
            }
            // 迁移这本书的进度 / 书签 / 配置，否则改名等于丢进度
            this.plugin.remapBookRecord(oldPath, file.path);
            this.plugin.saveSoon();
        }));
        // 正在读的文件被改动（同端编辑或同步拉回）：防抖后重渲染，保持阅读位置
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (!this.source || !(file instanceof obsidian_1.TFile)) {
                return;
            }
            const current = this.chapters[this.chapterIndex];
            if (!current || current.file.path !== file.path) {
                return;
            }
            if (this.modifyTimer !== null) {
                window.clearTimeout(this.modifyTimer);
            }
            this.modifyTimer = window.setTimeout(() => {
                this.modifyTimer = null;
                const src = this.source;
                if (!src) {
                    return;
                }
                void this.openSource(src);
            }, 1200);
        }));
        // 键盘翻页：注册在常驻容器上，只注册一次
        // （放进 buildShell 会随每次换书重复注册，导致一次按键翻好几页）
        this.containerEl.tabIndex = 0;
        this.registerDomEvent(this.containerEl, 'keydown', (evt) => {
            const active = document.activeElement;
            const tag = active ? active.tagName : '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') {
                return;
            }
            if (evt.key === 'ArrowRight' || evt.key === 'PageDown' || evt.key === ' ') {
                evt.preventDefault();
                this.turnPage(1);
            }
            else if (evt.key === 'ArrowLeft' || evt.key === 'PageUp') {
                evt.preventDefault();
                this.turnPage(-1);
            }
        });
        this.showEmptyState();
    }
    async onClose() {
        this.saveProgressNow();
        document.body.removeClass('nr-immersive');
        this.disposePaging();
    }
    /** 释放分页相关资源（ResizeObserver / 待处理 rAF / 防抖定时器） */
    disposePaging() {
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
        if (this.modifyTimer !== null) {
            window.clearTimeout(this.modifyTimer);
            this.modifyTimer = null;
        }
        this.pendingPage = 0;
        this.pendingExpire = 0;
    }
    async openSource(src) {
        // 换书前先释放上一本书的资源：旧 ResizeObserver 会强引用整棵旧 DOM 树
        this.disposePaging();
        this.source = src;
        const files = src.kind === 'file' ? [src.file] : await this.resolveFolderChapters(src.folder);
        if (files.length === 0) {
            this.showEmptyState();
            return;
        }
        this.chapters = await this.buildChapters(files);
        this.chaptersVersion += 1;
        if (this.chapters.length === 0) {
            new obsidian_1.Notice('这本书还没有可读内容');
            this.showEmptyState();
            return;
        }
        // 确认能打开后才记录 lastBook，避免把不可用的路径写进数据
        this.openPath = this.sourceKey();
        this.plugin.data.lastBook = this.openPath;
        this.plugin.saveSoon();
        this.contentEl.empty();
        this.contentEl.addClass('novel-reader');
        this.buildShell();
        this.applySettings();
        this.applyImmersive();
        this.ro = new ResizeObserver(() => {
            this.relayout(this.currentAnchor());
        });
        this.ro.observe(this.viewportEl);
        const progress = normalizeProgress(this.plugin.data.books[this.sourceKey()]);
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
            // 兼容旧配置：既支持相对路径，也支持纯文件名
            const matched = all.filter((f) => wanted.has(relPath(folder, f)) || wanted.has(f.name));
            if (matched.length > 0) {
                return matched;
            }
        }
        const picked = await pickChapters(this.app, folder, all);
        if (picked.length === 0) {
            return [];
        }
        this.plugin.data.bookConfig[folder.path] = { files: picked.map((f) => relPath(folder, f)) };
        this.plugin.saveSoon();
        return picked;
    }
    /** 构建章节列表：文件夹=每文件一章；单文件=按标题切虚拟章，无标题则按字数切 */
    async buildChapters(files) {
        const chapters = [];
        if (this.source && this.source.kind === 'folder') {
            for (const file of files) {
                if (isEmptyFile(file)) {
                    continue;
                }
                chapters.push({
                    file,
                    title: relativeLabel(this.source.folder, file),
                    level: 1,
                });
            }
            return chapters;
        }
        const file = files[0];
        const raw = await this.app.vault.cachedRead(file);
        const cache = this.app.metadataCache.getFileCache(file);
        const headings = (cache && cache.headings) || [];
        if (headings.length >= 1) {
            // markdown 书：章节边界来自 metadataCache，一个字符都不能预处理，否则 offset 全错
            this.bookText = null;
            this.plainText = false;
            const fmEnd = cache && cache.frontmatterPosition ? cache.frontmatterPosition.end.offset : 0;
            const base = resolveOffsetBase(raw, headings, fmEnd);
            const first = Math.max(0, headings[0].position.start.offset - base);
            // 标题之前若有前言/卷首内容，单独成章；否则只 1 个标题的书会退化成按字数乱切
            if (first > 0 && raw.slice(0, first).trim().length > 0) {
                chapters.push({ file, title: file.basename, level: 1, start: 0, end: first });
            }
            for (let i = 0; i < headings.length; i++) {
                const nextOff = i + 1 < headings.length ? headings[i + 1].position.start.offset : -1;
                const start = Math.max(0, headings[i].position.start.offset - base);
                const end = i + 1 < headings.length ? Math.max(start, nextOff - base) : raw.length;
                chapters.push({ file, title: headings[i].heading, level: headings[i].level, start, end });
            }
            return chapters;
        }
        // 没有 markdown 标题 → 当成网文爬站体纯文本：先规范化（关键是去掉行首缩进），
        // 再按「第 N 章」切章；切不出来才退回按字数切。
        const text = normalizePlainNovel(raw);
        this.bookText = text;
        this.plainText = true;
        const cuts = splitNovelChapters(text, file.basename, CHAPTER_MAX_CHARS);
        if (cuts.length > 0) {
            for (const c of cuts) {
                chapters.push({ file, title: c.title, level: 1, start: c.start, end: c.end });
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
            // 触摸序列开始：清掉上一轮可能残留的点击抑制标志（捏合不产生 click，会把它留到下一次点击）
            this.suppressClick = false;
            if (evt.touches.length === 1) {
                this.touchX = evt.touches[0].clientX;
                this.touchY = evt.touches[0].clientY;
                this.touchT = Date.now();
            }
            else if (evt.touches.length === 2) {
                this.pinchDist = touchDistance(evt.touches[0], evt.touches[1]);
                // 捏合的基准字号要用这本书当前生效的（开了「每本书独立排版」时和全局默认值不同）
                this.pinchFont = this.currentTypography().fontSize;
                // 取消单指滑动状态：否则捏合结束抬起第一根手指时会被判成横滑翻页
                this.touchT = 0;
            }
        }, { passive: true });
        this.registerDomEvent(overlay, 'touchmove', (evt) => {
            if (evt.touches.length === 2 && this.pinchDist > 0) {
                evt.preventDefault();
                const dist = touchDistance(evt.touches[0], evt.touches[1]);
                const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round((this.pinchFont * dist) / this.pinchDist)));
                this.suppressClick = true;
                this.applyFontSizeLive(next);
                return;
            }
            // 单指拖动：禁掉原生横向滚动，否则页面会停在两列之间的错位位置
            if (this.touchT > 0) {
                evt.preventDefault();
            }
        }, { passive: false });
        this.registerDomEvent(overlay, 'touchend', (evt) => {
            // 捏合结束：任意一根手指抬起就算结束（等 touches 归零会让剩下那根手指继续干扰）
            if (this.pinchDist > 0 && evt.touches.length < 2) {
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
        mkBtn('书签', () => this.toggleBookmark());
        mkBtn('搜索', () => void this.openSearch());
        mkBtn('书架', () => this.openBookshelf());
        mkBtn('换书', () => this.plugin.openPicker(this));
    }
    toggleSheet(force) {
        if (!this.sheetEl) {
            return;
        }
        const show = force !== undefined ? force : !this.sheetEl.hasClass('nr-open');
        this.sheetEl.toggleClass('nr-open', show);
    }
    /* ---------- 排版与主题 ---------- */
    /** 当前生效的排版：开了「每本书独立」就优先用这本书自己记住的那套 */
    currentTypography() {
        const s = this.plugin.data.settings;
        const own = s.perBookTypography && this.source
            ? this.plugin.data.bookStyle[this.sourceKey()]
            : undefined;
        return {
            fontSize: (own && own.fontSize) || s.fontSize,
            lineHeight: (own && own.lineHeight) || s.lineHeight,
            theme: (own && own.theme) || s.theme,
        };
    }
    /** 写排版：开了「每本书独立」写进这本书，否则写全局默认 */
    setTypography(patch) {
        const s = this.plugin.data.settings;
        if (s.perBookTypography && this.source) {
            const key = this.sourceKey();
            this.plugin.data.bookStyle[key] = {
                ...(this.plugin.data.bookStyle[key] || {}),
                ...patch,
            };
        }
        else {
            if (patch.fontSize !== undefined) {
                s.fontSize = patch.fontSize;
            }
            if (patch.lineHeight !== undefined) {
                s.lineHeight = patch.lineHeight;
            }
            if (patch.theme !== undefined) {
                s.theme = patch.theme;
            }
        }
        this.plugin.saveSoon();
    }
    /** 排版变化后按当前锚点重排 */
    refreshTypography() {
        this.applySettings();
        this.reflow();
    }
    changeFont(delta) {
        const t = this.currentTypography();
        this.setTypography({
            fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, t.fontSize + delta)),
        });
        // 必须走 refreshTypography：只写数据不刷 --nr-font 的话界面上字号不会变
        this.refreshTypography();
    }
    changeLineHeight(delta) {
        const t = this.currentTypography();
        this.setTypography({
            lineHeight: Math.min(LH_MAX, Math.max(LH_MIN, Math.round((t.lineHeight + delta) * 10) / 10)),
        });
        this.refreshTypography();
    }
    /** 捏合过程中实时应用字号（rAF 节流重排，抬手时才落盘） */
    applyFontSizeLive(size) {
        const t = this.currentTypography();
        if (t.fontSize === size) {
            return;
        }
        this.setTypography({ fontSize: size });
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
        const t = this.currentTypography();
        this.setTypography({ theme: order[(order.indexOf(t.theme) + 1) % order.length] });
        if (this.themeBtnEl) {
            this.themeBtnEl.setText(this.themeLabel());
        }
        this.applyTheme();
    }
    themeLabel() {
        const t = this.currentTypography().theme;
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
        const theme = this.currentTypography().theme;
        this.contentEl.toggleClass('nr-sepia', theme === 'sepia');
        this.contentEl.toggleClass('nr-dark', theme === 'dark');
    }
    applySettings() {
        const t = this.currentTypography();
        this.contentEl.style.setProperty('--nr-font', `${t.fontSize}px`);
        this.contentEl.style.setProperty('--nr-lh', String(t.lineHeight));
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
        const md = await this.chapterText(chapter);
        this.pageEl.empty();
        const holder = this.pageEl.createDiv({ cls: 'nr-chapter' });
        if (this.plainText) {
            this.renderPlainText(holder, md);
        }
        else {
            await obsidian_1.MarkdownRenderer.render(this.app, md, holder, chapter.file.path, this);
        }
        this.cidEls = [];
        let cid = 0;
        for (const el of Array.from(holder.children)) {
            el.dataset.cid = String(cid++);
            this.cidEls.push(el);
        }
        this.relayout(undefined, target);
        this.saveProgressNow();
    }
    /**
     * 纯文本小说：逐行生成 <p>，标题行单独成 <h3>。
     * 比 MarkdownRenderer 快得多，也彻底避开「整篇缩进被当成代码块」的坑。
     */
    renderPlainText(holder, text) {
        const lines = text.split('\n');
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) {
                continue;
            }
            if (isChapterLine(line)) {
                holder.createEl('h3', { text: line.slice(0, 40) });
            }
            else {
                holder.createEl('p', { text: line });
            }
        }
    }
    reflow() {
        this.relayout(this.currentAnchor());
    }
    /** 重算分页并定位：anchor 用于重排（保持当前位置），target 用于章节加载后的跳转 */
    relayout(anchor, target) {
        if (!this.viewportEl || !this.pageEl) {
            return;
        }
        // 章节或布局变了，旧的动画目标失效
        this.pendingExpire = 0;
        this.pendingPage = 0;
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
    /** 翻页基准：平滑动画进行中直接用目标页，避免读到动画中间的 scrollLeft 造成连点丢页 */
    basePage() {
        if (this.pendingExpire && Date.now() < this.pendingExpire) {
            return this.pendingPage;
        }
        this.pendingExpire = 0;
        return this.currentPageIndex();
    }
    turnPage(dir) {
        if (!this.viewportEl) {
            return;
        }
        this.toggleSheet(false);
        const target = this.basePage() + dir;
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
        this.pendingPage = target;
        this.pendingExpire = Date.now() + 450;
        this.viewportEl.scrollTo({ left: target * this.stride(), behavior: 'smooth' });
    }
    currentAnchor() {
        if (!this.viewportEl) {
            return { chapter: this.chapterIndex, cid: 0, percent: 0, overall: 0, updatedAt: 0 };
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
        return { chapter: this.chapterIndex, cid, percent, overall: 0, updatedAt: 0 };
    }
    saveProgressNow() {
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
    overallPercent() {
        if (this.chapters.length === 0) {
            return 0;
        }
        const page = Math.min(this.pageCount, this.currentPageIndex() + 1);
        return Math.round(((this.chapterIndex + page / this.pageCount) / this.chapters.length) * 100);
    }
    updateStatus() {
        if (!this.statusEl) {
            return;
        }
        const page = Math.min(this.pageCount, this.currentPageIndex() + 1);
        const totalChapters = Math.max(1, this.chapters.length);
        const overall = this.overallPercent();
        this.statusEl.setText(`${this.bookTitle()} · 第 ${this.chapterIndex + 1}/${totalChapters} 章 · ${page}/${this.pageCount} 页 · ${overall}%`);
    }
    async openToc() {
        if (this.chapters.length === 0) {
            return;
        }
        const entries = this.chapters.map((chapter, i) => ({
            label: chapter.title,
            level: chapter.level,
            onClick: () => void this.loadChapter(i, { page: 0 }),
        }));
        this.toggleSheet(false);
        new TocModal(this.app, entries, this.chapterIndex).open();
    }
    /** 关闭当前书籍、回到空状态（书架里移除某书后调用） */
    closeSource() {
        this.showEmptyState();
    }
    openBookshelf() {
        this.toggleSheet(false);
        new BookshelfModal(this.plugin, this).open();
    }
    /** 取出某一章的正文：有整本缓存就按偏移量切片，否则读文件再切 */
    async chapterText(chapter) {
        if (this.bookText !== null && chapter.start !== undefined && chapter.end !== undefined) {
            return this.bookText.slice(chapter.start, chapter.end);
        }
        const text = await this.app.vault.cachedRead(chapter.file);
        if (chapter.start !== undefined && chapter.end !== undefined) {
            return text.slice(chapter.start, chapter.end);
        }
        return text;
    }
    /** 书签：在当前位置添加/移除（同一位置再点一次即移除） */
    toggleBookmark() {
        if (!this.source) {
            return;
        }
        const key = this.sourceKey();
        const anchor = this.currentAnchor();
        const list = this.plugin.data.bookmarks[key] || [];
        const hit = list.findIndex((b) => b.chapter === anchor.chapter && Math.abs(b.percent - anchor.percent) < 0.005);
        if (hit >= 0) {
            list.splice(hit, 1);
            new obsidian_1.Notice('已移除书签');
        }
        else {
            const anchorEl = this.cidEls[anchor.cid];
            const raw = anchorEl ? anchorEl.getText() : '';
            const chapter = this.chapters[anchor.chapter];
            const excerpt = raw.replace(/\s+/g, ' ').slice(0, 24) || (chapter ? chapter.title : this.bookTitle());
            list.push({ chapter: anchor.chapter, cid: anchor.cid, percent: anchor.percent, excerpt });
            new obsidian_1.Notice(`已添加书签：${excerpt}`);
        }
        this.plugin.data.bookmarks[key] = list;
        this.plugin.saveSoon();
        this.toggleSheet(false);
    }
    /** 搜索索引：按章读但可以边读边搜，避免全书一次性读进内存时卡住 */
    ensureIndex() {
        if (this.indexVersion === this.chaptersVersion) {
            return;
        }
        const version = this.chaptersVersion;
        this.indexVersion = version;
        this.chapterTexts = new Array(this.chapters.length).fill('');
        void this.buildIndex(version);
    }
    async buildIndex(version) {
        for (let i = 0; i < this.chapters.length; i++) {
            if (this.chaptersVersion !== version) {
                return;
            }
            try {
                this.chapterTexts[i] = await this.chapterText(this.chapters[i]);
            }
            catch (_a) {
                // 章节文件可能在索引构建过程中被删掉，跳过即可
                this.chapterTexts[i] = '';
            }
        }
    }
    /** 书内搜索：弹窗立即打开，索引在后台陆续补齐 */
    openSearch() {
        if (this.chapters.length === 0) {
            return;
        }
        this.toggleSheet(false);
        // 单文件大书直接用内存里的整本缓存做全文匹配，不必给每一章再复制一份文本
        if (this.bookText === null) {
            this.ensureIndex();
        }
        new ReaderSearchModal(this.app, this, this.chapters, this.chapterTexts).open();
    }
    /**
     * 单文件大书的全文搜索：一次 indexOf 扫到底，按命中偏移反查章节。
     * 有整本缓存时才返回数组，否则返回 null（交给逐章索引那条路）。
     */
    searchFullText(query, limit) {
        if (this.bookText === null || query.length === 0) {
            return null;
        }
        const out = [];
        let from = 0;
        while (out.length < limit) {
            const at = this.bookText.indexOf(query, from);
            if (at < 0) {
                break;
            }
            const chapter = this.chapterAtOffset(at);
            const snippet = this.bookText
                .slice(Math.max(0, at - 8), at + query.length + 24)
                .replace(/\s+/g, ' ');
            out.push({
                kind: 'search',
                chapter,
                title: this.chapters[chapter] ? this.chapters[chapter].title : '',
                snippet,
                query,
            });
            from = at + Math.max(1, query.length);
        }
        return out;
    }
    /** 命中偏移属于第几章（chapters 按 start 升序） */
    chapterAtOffset(off) {
        var _a;
        let lo = 0;
        let hi = this.chapters.length - 1;
        let ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const start = (_a = this.chapters[mid].start) !== null && _a !== void 0 ? _a : 0;
            if (start <= off) {
                ans = mid;
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }
        return ans;
    }
    /** 跳到某章，并定位到首个包含指定文字的段落 */
    async jumpToChapterText(chapterIndex, query) {
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
    getBookmarks() {
        if (!this.source) {
            return [];
        }
        return this.plugin.data.bookmarks[this.sourceKey()] || [];
    }
    async jumpToBookmark(item) {
        await this.loadChapter(item.chapter, { cid: item.cid, percent: item.percent });
    }
    showEmptyState() {
        this.source = null;
        this.openPath = '';
        this.bookText = null;
        this.plainText = false;
        this.chapters = [];
        this.chaptersVersion += 1;
        this.chapterTexts = [];
        this.chapterIndex = 0;
        this.cidEls = [];
        this.pageCount = 1;
        this.disposePaging();
        // DOM 已被清空，清掉这些引用，避免后续操作到游离节点上
        this.viewportEl = null;
        this.pageEl = null;
        this.statusEl = null;
        this.sheetEl = null;
        this.themeBtnEl = null;
        document.body.removeClass('nr-immersive');
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
/** 按路径分段做自然排序：`第一卷/第2章.md` 排在 `第二卷/第1章.md` 前面 */
function comparePaths(a, b) {
    const as = a.split('/');
    const bs = b.split('/');
    const n = Math.min(as.length, bs.length);
    for (let i = 0; i < n; i++) {
        const cmp = naturalCompare(as[i], bs[i]);
        if (cmp !== 0) {
            return cmp;
        }
    }
    return as.length - bs.length;
}
/** 递归收集文件夹下的所有 Markdown（含子文件夹），跳过空占位文件，按路径排序 */
function listChapterFiles(folder) {
    const found = [];
    const walk = (current) => {
        for (const child of current.children) {
            if (child instanceof obsidian_1.TFile && child.extension === 'md') {
                if (!isEmptyFile(child)) {
                    found.push(child);
                }
            }
            else if (child instanceof obsidian_1.TFolder) {
                walk(child);
            }
        }
    };
    walk(folder);
    return found.sort((a, b) => comparePaths(a.path, b.path));
}
/** 0 字节或近乎空的占位 md：渲染出来只有一张白页 */
function isEmptyFile(file) {
    const size = file && file.stat ? file.stat.size : 0;
    return size <= 4;
}
/** 章节相对书根的路径标签，如 `左道/术法` */
function relativeLabel(root, file) {
    const prefix = root.path + '/';
    const rel = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.name;
    return rel.replace(/\.md$/, '');
}
function relPath(root, file) {
    const prefix = root.path + '/';
    return file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.name;
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
            row.createSpan({ text: relativeLabel(folder, f) });
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
/**
 * 输入为空时列出本书书签，有输入时对全书正文做子串匹配。
 */
class ReaderSearchModal extends obsidian_1.FuzzySuggestModal {
    constructor(app, view, chapters, texts) {
        super(app);
        this.view = view;
        this.chapters = chapters;
        this.texts = texts;
        this.setPlaceholder('搜索正文（留空查看书签）…');
    }
    getItems() {
        const query = this.inputEl.value.trim();
        if (query.length === 0) {
            const marks = this.view.getBookmarks();
            return marks.map((item) => ({ kind: 'bookmark', item }));
        }
        // 单文件大书：整本缓存里一次扫完，比逐章匹配快几个数量级
        const direct = this.view.searchFullText(query, 60);
        if (direct) {
            return direct;
        }
        const lower = query.toLowerCase();
        const out = [];
        for (let i = 0; i < this.texts.length && out.length < 60; i++) {
            if (!this.texts[i]) {
                continue;
            }
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
    getItemText(item) {
        if (item.kind === 'bookmark') {
            return `★ ${item.item.excerpt}`;
        }
        return `${item.title} ${item.snippet}`;
    }
    onChooseItem(item) {
        if (item.kind === 'bookmark') {
            void this.view.jumpToBookmark(item.item);
        }
        else {
            void this.view.jumpToChapterText(item.chapter, item.query);
        }
    }
}
/* ---------------- 书架 / 选书 / 搜索 ---------------- */
/** 书架：继续阅读 + 读过清单（带进度与移除）+ 浏览全库加书 */
class BookshelfModal extends obsidian_1.Modal {
    constructor(plugin, view) {
        super(plugin.app);
        this.plugin = plugin;
        this.view = view;
    }
    onOpen() {
        this.contentEl.addClass('nr-shelf');
        this.titleEl.setText('书架');
        const shelf = this.plugin.getShelf();
        const currentKey = this.view.hasSource ? this.view.sourceKey() : null;
        if (shelf.length === 0) {
            const hint = this.contentEl.createDiv({ cls: 'nr-shelf-hint' });
            hint.setText('书架还是空的，从下面浏览库添加一本书吧');
        }
        else {
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
                    if (af instanceof obsidian_1.TFile) {
                        void this.view.openSource({ kind: 'file', file: af });
                    }
                    else if (af instanceof obsidian_1.TFolder) {
                        void this.view.openSource({ kind: 'folder', folder: af });
                    }
                    else {
                        new obsidian_1.Notice('这本书已不在库中');
                    }
                    this.close();
                };
                const delBtn = row.createEl('button', { cls: 'nr-btn nr-btn-danger', text: '移除' });
                delBtn.onclick = () => {
                    new ConfirmModal(this.app, '从书架移除', `移除《${entry.title}》的阅读记录、书签与章节配置？`, () => {
                        this.plugin.removeFromShelf(entry.key);
                        new obsidian_1.Notice(`已移除《${entry.title}》`);
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
class ConfirmModal extends obsidian_1.Modal {
    constructor(app, title, message, onConfirm) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
    }
    onOpen() {
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
class BookSuggester extends obsidian_1.FuzzySuggestModal {
    constructor(plugin, view) {
        super(plugin.app);
        this.plugin = plugin;
        this.view = view;
        this.setPlaceholder('搜索书籍（文件路径 / 书名均可）…');
    }
    /** 列出可选的书：默认递归进子文件夹，设置里可以关掉只留根目录 */
    getItems() {
        const deep = this.plugin.data.settings.deepBrowse;
        const items = [];
        const walk = (folder) => {
            for (const child of folder.children) {
                if (child instanceof obsidian_1.TFile) {
                    if (child.extension === 'md' && !isEmptyFile(child)) {
                        items.push({ kind: 'file', file: child });
                    }
                }
                else if (child instanceof obsidian_1.TFolder && !child.name.startsWith('.') && folderHasMd(child)) {
                    items.push({ kind: 'folder', folder: child });
                    if (deep) {
                        walk(child);
                    }
                }
            }
        };
        walk(this.app.vault.getRoot());
        return items;
    }
    getItemText(item) {
        const path = item.kind === 'file' ? item.file.path : item.folder.path;
        // 带上路径，递归浏览时能分清同名章节文件在哪一层
        const label = path.replace(/\.md$/, '');
        const stored = this.plugin.data.books[path];
        const prefix = stored ? `已读 ${stored.overall}% · ` : '';
        if (item.kind === 'file') {
            return `${prefix}${label} · 单文件`;
        }
        return `${prefix}${label} · 文件夹 · ${countMd(item.folder)} 篇`;
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
function countMd(folder) {
    let n = 0;
    for (const child of folder.children) {
        if (child instanceof obsidian_1.TFile && child.extension === 'md') {
            if (!isEmptyFile(child)) {
                n += 1;
            }
        }
        else if (child instanceof obsidian_1.TFolder) {
            n += countMd(child);
        }
    }
    return n;
}
function folderHasMd(folder) {
    return countMd(folder) > 0;
}
class TocModal extends obsidian_1.Modal {
    constructor(app, entries, currentIndex) {
        super(app);
        this.entries = entries;
        this.currentIndex = currentIndex;
    }
    onOpen() {
        this.contentEl.addClass('nr-toc');
        this.titleEl.setText('目录');
        // 用对象装：闭包里赋值，TS 的控制流分析跟不到裸 let，会把类型收窄成 null
        const state = { currentEl: null };
        const list = this.contentEl.createDiv({ cls: 'nr-toc-list' });
        let rendered = 0;
        // 大书可能上千章，一次全渲染会卡住弹窗：分批渲染，剩下的点按钮追加
        const moreBtn = this.contentEl.createEl('button', {
            cls: 'nr-btn nr-toc-more',
            text: '显示更多',
        });
        if (this.entries.length > TOC_PAGE) {
            this.contentEl.createDiv({
                cls: 'nr-shelf-hint',
                text: `共 ${this.entries.length} 章，先显示前 ${TOC_PAGE} 章`,
            });
        }
        const renderMore = () => {
            const end = Math.min(this.entries.length, rendered + TOC_PAGE);
            for (let i = rendered; i < end; i++) {
                const entry = this.entries[i];
                const btn = list.createEl('button', {
                    cls: `nr-toc-item nr-toc-l${Math.min(entry.level, 4)}`,
                    text: entry.label,
                });
                if (i === this.currentIndex) {
                    btn.addClass('nr-toc-current');
                    state.currentEl = btn;
                }
                btn.onclick = () => {
                    entry.onClick();
                    this.close();
                };
            }
            rendered = end;
            moreBtn.style.display = rendered < this.entries.length ? '' : 'none';
        };
        moreBtn.onclick = () => renderMore();
        renderMore();
        // 目录很长时把当前章滚到可见处
        const el = state.currentEl;
        if (el) {
            window.setTimeout(() => {
                try {
                    el.scrollIntoView({ block: 'center' });
                }
                catch (_a) {
                    el.scrollIntoView();
                }
            }, 0);
        }
    }
}
/* ---------------- 设置面板 ---------------- */
class NovelReaderSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        const settings = this.plugin.data.settings;
        const view = this.plugin.getActiveReaderView();
        const perBookHere = settings.perBookTypography && !!view && view.hasSource;
        const current = perBookHere && view ? view.currentTypography() : null;
        new obsidian_1.Setting(containerEl).setName('排版').setHeading();
        containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: perBookHere
                ? '「每本书独立排版」已开启：下面的字号 / 行距 / 主题改的是当前正在读的这本。'
                : '下面的字号 / 行距 / 主题是全局默认值，新书会先套用这套。',
        });
        new obsidian_1.Setting(containerEl)
            .setName('字号')
            .setDesc(`${current ? current.fontSize : settings.fontSize} px（${FONT_MIN}–${FONT_MAX}）`)
            .addSlider((slider) => {
            slider
                .setLimits(FONT_MIN, FONT_MAX, 1)
                .setDynamicTooltip()
                .setValue(current ? current.fontSize : settings.fontSize)
                .onChange((value) => {
                this.plugin.applyTypography({ fontSize: value });
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName('行距')
            .setDesc(`${(current ? current.lineHeight : settings.lineHeight).toFixed(1)}（${LH_MIN}–${LH_MAX}）`)
            .addSlider((slider) => {
            slider
                .setLimits(LH_MIN, LH_MAX, 0.1)
                .setDynamicTooltip()
                .setValue(current ? current.lineHeight : settings.lineHeight)
                .onChange((value) => {
                this.plugin.applyTypography({ lineHeight: Math.round(value * 10) / 10 });
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName('主题')
            .setDesc('跟随 Obsidian / 米色护眼 / 暗黑')
            .addDropdown((drop) => {
            drop
                .addOption('auto', '跟随主题')
                .addOption('sepia', '米色')
                .addOption('dark', '暗黑')
                .setValue(current ? current.theme : settings.theme)
                .onChange((value) => {
                this.plugin.applyTypography({ theme: value });
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName('每本书独立排版')
            .setDesc('开启后，某本书里调好的字号主题不会被另一本书带走')
            .addToggle((toggle) => {
            toggle.setValue(settings.perBookTypography).onChange((value) => {
                settings.perBookTypography = value;
                this.plugin.saveSoon();
                this.plugin.refreshReaderViews();
                this.display();
            });
        });
        if (perBookHere && view) {
            new obsidian_1.Setting(containerEl)
                .setName('重置当前这本书的排版')
                .setDesc('让它重新沿用上面的默认值')
                .addButton((btn) => {
                btn.setButtonText('重置').onClick(() => {
                    this.plugin.clearBookStyle(view.sourceKey());
                    new obsidian_1.Notice('这本书已恢复默认排版');
                    this.display();
                });
            });
        }
        new obsidian_1.Setting(containerEl).setName('阅读').setHeading();
        new obsidian_1.Setting(containerEl)
            .setName('沉浸模式')
            .setDesc('隐藏 Obsidian 标题栏与移动端导航栏')
            .addToggle((toggle) => {
            toggle.setValue(settings.immersive).onChange((value) => {
                settings.immersive = value;
                this.plugin.saveSoon();
                this.plugin.refreshReaderViews();
                this.display();
            });
        });
        new obsidian_1.Setting(containerEl).setName('书库').setHeading();
        new obsidian_1.Setting(containerEl)
            .setName('递归浏览书库')
            .setDesc('选书时一并列出子文件夹里的书籍；关掉则只列库根目录')
            .addToggle((toggle) => {
            toggle.setValue(settings.deepBrowse).onChange((value) => {
                settings.deepBrowse = value;
                this.plugin.saveSoon();
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName('清除所有书的排版记忆')
            .setDesc('全部恢复默认值，书签与阅读进度不受影响')
            .addButton((btn) => {
            btn
                .setWarning()
                .setButtonText('清除')
                .onClick(() => {
                new ConfirmModal(this.app, '清除排版记忆', '清除所有书籍单独保存的字号 / 行距 / 主题？书签与阅读进度会保留。', () => {
                    this.plugin.clearBookStyle();
                    new obsidian_1.Notice('已清除所有书的排版记忆');
                    this.display();
                }).open();
            });
        });
    }
}
