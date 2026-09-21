"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookshelfView = exports.NovelReaderView = exports.FINISHED_PERCENT = exports.NOVEL_READER_SHELF_VIEW_TYPE = exports.NOVEL_READER_VIEW_TYPE = void 0;
/**
 * Novel Reader — M3
 * 分页：CSS multi-column（column-fill: auto + 固定高），横向滚动按列翻页。
 * 渲染：按章按需渲染，DOM 中只保留当前章节；单文件大书按标题切成虚拟章。
 * 进度：（章节序号 + 段落锚点 + 章内页比例）三重冗余，页码永不落盘。
 * 移动端红线：不 import fs/path/electron；正则不使用 lookbehind；单文件构建。
 */
const obsidian_1 = require("obsidian");
exports.NOVEL_READER_VIEW_TYPE = 'novel-reader-view';
/** 书架是独立视图：不打开阅读器也能直接进 */
exports.NOVEL_READER_SHELF_VIEW_TYPE = 'novel-reader-shelf-view';
/** 单文件大书无标题时，按此字数切虚拟章（在段落边界断开） */
const CHUNK_SIZE = 8000;
/** 单章字数上限：再长就在段落边界补切一刀，避免一章的 DOM 太大拖慢排版 */
const CHAPTER_MAX_CHARS = 24000;
/** 短于这个长度的"章"视为连续标题行（「第一卷」「第一章」紧挨着），合并掉 */
const MIN_CHAPTER_CHARS = 300;
/** 目录弹窗一次渲染多少条，超出的点「显示更多」追加（大书可能有上千章） */
const TOC_PAGE = 300;
/** 浏览全库弹窗一次渲染多少条 */
const BROWSE_PAGE = 80;
const GAP = 48;
const FONT_MIN = 12;
const FONT_MAX = 30;
const LH_MIN = 1.4;
const LH_MAX = 2.6;
/** 读到 95% 以上就算读完（overall 是按章节估算的，很难正好到 100） */
exports.FINISHED_PERCENT = 95;
const DEFAULTS = {
    settings: {
        fontSize: 17,
        lineHeight: 1.9,
        theme: 'auto',
        immersive: true,
        perBookTypography: true,
        deepBrowse: true,
        shelfView: 'grid',
    },
    lastBook: null,
    books: {},
    bookConfig: {},
    bookmarks: {},
    bookStyle: {},
    shelf: {},
    shelfMeta: {},
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
        chapterTitle: typeof rec.chapterTitle === 'string' ? rec.chapterTitle : '',
        chapterCount: Math.max(0, Math.floor(num(rec.chapterCount, 0))),
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
            // 0.2.x 只有进度表，没有收藏表：老数据直接当空收藏表，书架行为保持不变
            shelf: (loaded && loaded.shelf) || {},
            shelfMeta: (loaded && loaded.shelfMeta) || {},
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
        this.registerView(exports.NOVEL_READER_SHELF_VIEW_TYPE, (leaf) => {
            return new BookshelfView(leaf, this);
        });
        // 阅读器没打开时也要维护书籍数据：在文件树里改名/删掉一本书不该让进度凭空消失
        // （视图打开着的情形由视图自己处理，这里跳过，避免重复迁移）
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            invalidateFolderCache();
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
            invalidateFolderCache();
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
        // 文件夹篇数缓存：任何可能改变 md 数量的变动都整表失效（重建很便宜，正确性优先）
        this.registerEvent(this.app.vault.on('create', () => {
            invalidateFolderCache();
        }));
        this.registerEvent(this.app.vault.on('modify', (file) => {
            // 空占位文件被写入正文后才会计入篇数，所以 md 改动也要失效
            if (file instanceof obsidian_1.TFile && file.extension === 'md') {
                invalidateFolderCache();
            }
        }));
        this.addSettingTab(new NovelReaderSettingTab(this.app, this));
        this.addRibbonIcon('book-open', '小说阅读器', () => {
            void this.openReader();
        });
        this.addRibbonIcon('library', '小说书架', () => {
            void this.openShelf();
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
        // 书架是独立视图：不需要先打开阅读器，命令面板里随时能进
        this.addCommand({
            id: 'open-book-shelf',
            name: '打开书架',
            callback: () => {
                void this.openShelf();
            },
        });
        this.addCommand({
            id: 'toggle-shelf-star',
            name: '把当前书籍加入/移出书架',
            checkCallback: (checking) => {
                const view = this.getActiveReaderView();
                if (!view || !view.hasSource) {
                    return false;
                }
                if (!checking) {
                    const key = view.sourceKey();
                    const starred = this.toggleShelf(key);
                    new obsidian_1.Notice(starred ? `已把《${view.getDisplayText()}》加入书架` : '已移出书架收藏');
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
    /** 打开或复用阅读器视图（不自动选书），书架要打开某本书时用它 */
    async ensureReaderView() {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(exports.NOVEL_READER_VIEW_TYPE);
        let leaf = existing.length > 0 ? existing[0] : null;
        if (!leaf) {
            leaf = workspace.getLeaf(false);
            await leaf.setViewState({ type: exports.NOVEL_READER_VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
        return leaf.view instanceof NovelReaderView ? leaf.view : null;
    }
    /** 从书架打开一本书：阅读器没开就先开一个，再载入这本书 */
    async openBook(src) {
        const view = await this.ensureReaderView();
        if (view) {
            await view.openSource(src);
        }
    }
    async openReader() {
        const view = await this.ensureReaderView();
        if (!view || view.hasSource) {
            return;
        }
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
    /** 打开独立书架视图（已经开着就直接切过去并刷新） */
    async openShelf() {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(exports.NOVEL_READER_SHELF_VIEW_TYPE);
        let leaf = existing.length > 0 ? existing[0] : null;
        if (!leaf) {
            leaf = workspace.getLeaf(false);
            await leaf.setViewState({ type: exports.NOVEL_READER_SHELF_VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
        if (leaf.view instanceof BookshelfView) {
            leaf.view.refresh();
        }
    }
    /** 书架视图可能开着多个，书籍数据变动后统一刷新 */
    refreshShelfViews() {
        for (const leaf of this.app.workspace.getLeavesOfType(exports.NOVEL_READER_SHELF_VIEW_TYPE)) {
            if (leaf.view instanceof BookshelfView) {
                leaf.view.refresh();
            }
        }
    }
    openPicker(view) {
        new BookSuggester(this, view).open();
    }
    /**
     * 书架 = 收藏过的书 ∪ 读过的书，按最近活动排序。
     * 只留"真正读过"的进度：误开一次的单章/设定稿（overall=0 且从未写入过进度）
     * 不该占书架位置——除非手动收藏过。
     */
    getShelf() {
        const keys = new Set(Object.keys(this.data.books));
        for (const key of Object.keys(this.data.shelf)) {
            keys.add(key);
        }
        const entries = [];
        for (const key of keys) {
            const progress = this.data.books[key];
            const starredAt = this.data.shelf[key] || 0;
            if (!starredAt && progress && progress.updatedAt === 0 && progress.overall === 0) {
                continue;
            }
            const af = this.app.vault.getAbstractFileByPath(key);
            const meta = this.data.shelfMeta[key] || {};
            const overall = progress ? progress.overall : 0;
            const base = {
                key,
                overall,
                updatedAt: Math.max(starredAt, progress ? progress.updatedAt : 0),
                starred: starredAt > 0,
                pinned: (meta.pin || 0) > 0,
                chapterTitle: progress && progress.chapterTitle ? progress.chapterTitle : '',
                chapterCount: progress && progress.chapterCount ? progress.chapterCount : 0,
                bookmarks: (this.data.bookmarks[key] || []).length,
                unread: !progress || (progress.overall === 0 && progress.updatedAt === 0),
                finished: overall >= exports.FINISHED_PERCENT,
            };
            if (af instanceof obsidian_1.TFolder) {
                entries.push({
                    ...base,
                    kind: 'folder',
                    title: meta.alias || af.name,
                    realTitle: af.name,
                    detail: `文件夹 · ${countMd(af)} 篇`,
                });
            }
            else if (af instanceof obsidian_1.TFile) {
                entries.push({
                    ...base,
                    kind: 'file',
                    title: meta.alias || af.basename,
                    realTitle: af.basename,
                    detail: '单文件',
                });
            }
        }
        // 置顶的书永远在最前，其余按最近活动倒序（具体排序键由书架界面决定）
        return entries.sort((a, b) => {
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }
            return b.updatedAt - a.updatedAt;
        });
    }
    /** 书架附加信息（置顶 / 显示名），没设置过时返回空对象 */
    shelfMetaOf(path) {
        return this.data.shelfMeta[path] || {};
    }
    writeShelfMeta(path, patch) {
        const current = this.data.shelfMeta[path] || {};
        const next = { ...current, ...patch };
        if (!next.alias) {
            delete next.alias;
        }
        if (!next.pin) {
            delete next.pin;
        }
        // 全空就整条删掉，别在数据里留下 {} 这种垃圾
        if (next.alias === undefined && next.pin === undefined) {
            delete this.data.shelfMeta[path];
        }
        else {
            this.data.shelfMeta[path] = next;
        }
        this.saveSoon();
    }
    /** 给书起一个只在书架里生效的显示名，传空串表示恢复真实文件名 */
    setBookAlias(path, alias) {
        this.writeShelfMeta(path, { alias: alias.trim() });
    }
    /** 置顶开关，返回操作后的状态（true = 已置顶） */
    togglePin(path) {
        const current = this.data.shelfMeta[path];
        const on = !(current && current.pin);
        this.writeShelfMeta(path, { pin: on ? Date.now() : 0 });
        return on;
    }
    /** 重置某本书的阅读进度（收藏、书签都保留） */
    resetBookProgress(path) {
        delete this.data.books[path];
        this.saveSoon();
    }
    /** 收藏一本书：没读过也能上架 */
    addToShelf(path) {
        this.data.shelf[path] = Date.now();
        this.saveSoon();
    }
    isStarred(path) {
        return !!this.data.shelf[path];
    }
    /** 收藏开关，返回操作后的状态（true = 已收藏） */
    toggleShelf(path) {
        if (this.data.shelf[path]) {
            delete this.data.shelf[path];
            this.saveSoon();
            return false;
        }
        this.addToShelf(path);
        return true;
    }
    /**
     * 清理两类垃圾记录：文件已不在库的（失效），以及从未真正读过又没收藏的（僵尸）。
     * 只动插件自己的数据，不动库里的文件。
     */
    pruneStale() {
        const d = this.data;
        const alive = (key) => !!this.app.vault.getAbstractFileByPath(key);
        let missing = 0;
        let zombie = 0;
        const stores = [
            d.books,
            d.bookConfig,
            d.bookmarks,
            d.bookStyle,
            d.shelf,
            d.shelfMeta,
        ];
        for (const store of stores) {
            for (const key of Object.keys(store)) {
                if (!alive(key)) {
                    delete store[key];
                    missing += 1;
                }
            }
        }
        for (const key of Object.keys(d.books)) {
            const p = d.books[key];
            if (!d.shelf[key] && p.updatedAt === 0 && p.overall === 0) {
                delete d.books[key];
                zombie += 1;
            }
        }
        if (d.lastBook && !alive(d.lastBook)) {
            d.lastBook = null;
        }
        if (missing + zombie > 0) {
            this.saveSoon();
        }
        return { missing, zombie };
    }
    /** 从书架移除：清掉进度、收藏、书签与章节配置（书本身不动） */
    removeFromShelf(key) {
        delete this.data.books[key];
        delete this.data.bookmarks[key];
        delete this.data.bookConfig[key];
        delete this.data.bookStyle[key];
        delete this.data.shelf[key];
        delete this.data.shelfMeta[key];
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
        if (d.shelf[oldPath]) {
            d.shelf[newPath] = d.shelf[oldPath];
            delete d.shelf[oldPath];
        }
        if (d.shelfMeta[oldPath]) {
            d.shelfMeta[newPath] = d.shelfMeta[oldPath];
            delete d.shelfMeta[oldPath];
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
        // 书架要显示「读到哪了」：章节标题与总章数一起记下来
        const chapter = this.chapters[this.chapterIndex];
        anchor.chapterTitle = chapter ? chapter.title : '';
        anchor.chapterCount = this.chapters.length;
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
        new BookshelfModal(this.plugin).open();
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
/** 最后活动时间的人类可读形式，书架里比裸时间戳好用 */
function formatRelative(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) {
        return '刚刚';
    }
    if (diff < 3600000) {
        return `${Math.floor(diff / 60000)} 分钟前`;
    }
    if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)} 小时前`;
    }
    if (diff < 2592000000) {
        return `${Math.floor(diff / 86400000)} 天前`;
    }
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const SHELF_TABS = [
    { id: 'all', label: '全部' },
    { id: 'reading', label: '在读' },
    { id: 'starred', label: '收藏' },
    { id: 'unread', label: '未读' },
    { id: 'finished', label: '读完' },
];
/** 封面色：按路径哈希出一个稳定色相，同一本书每次打开都同色 */
function coverHue(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = (h * 31 + key.charCodeAt(i)) % 360;
    }
    return h;
}
/** 封面首字：西文取首字母大写，其他（中文等）取第一个字 */
function coverLetter(title) {
    const t = title.trim();
    if (t.length === 0) {
        return '书';
    }
    const ch = t.charAt(0);
    return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}
/**
 * 书架列表：网格/列表两种形态、分类标签、排序过滤、批量操作、详情面板。
 * 阅读器里的书架弹窗和常驻书架视图共用这一份实现，行为始终一致。
 */
class ShelfList {
    constructor(host, root) {
        this.entries = [];
        this.sort = 'recent';
        this.tab = 'all';
        this.filter = '';
        this.selecting = false;
        this.selected = new Set();
        this.listEl = null;
        this.hintEl = null;
        this.host = host;
        this.root = root;
        this.app = host.plugin.app;
        // 上次用过的形态记在设置里，下次打开还是它
        this.mode = host.plugin.data.settings.shelfView === 'list' ? 'list' : 'grid';
    }
    /** 重新取数据并整体重画（外部改动了书籍数据后调用） */
    refresh() {
        this.entries = this.host.plugin.getShelf();
        this.render();
    }
    render() {
        const root = this.root;
        root.empty();
        // root 由宿主创建并复用，重复 addClass 会让 class 越堆越长
        if (!root.hasClass('nr-shelf')) {
            root.addClass('nr-shelf');
        }
        if (this.entries.length === 0) {
            this.renderEmpty(root);
            return;
        }
        this.renderToolbar(root);
        this.renderTabs(root);
        if (this.selecting) {
            this.renderSelectionBar(root);
        }
        this.hintEl = root.createDiv({ cls: 'nr-shelf-hint' });
        this.listEl = root.createDiv({
            cls: `nr-shelf-list${this.mode === 'grid' ? ' nr-shelf-grid' : ''}`,
        });
        this.renderList();
        this.renderActions(root);
    }
    renderEmpty(parent) {
        parent.createDiv({
            cls: 'nr-shelf-hint',
            text: '书架还是空的，从下面浏览库添加一本书吧',
        });
        const actions = parent.createDiv({ cls: 'nr-shelf-actions' });
        const btn = actions.createEl('button', {
            cls: 'nr-btn nr-btn-primary',
            text: '浏览全库添加书籍',
        });
        btn.onclick = () => {
            new BookBrowserModal(this.host.plugin, () => this.refresh()).open();
        };
    }
    renderToolbar(parent) {
        const bar = parent.createDiv({ cls: 'nr-shelf-toolbar' });
        const input = bar.createEl('input', { type: 'search' });
        input.placeholder = '过滤书名或路径…';
        input.value = this.filter;
        // 精简版 obsidian.d.ts 的 Modal 没有 registerDomEvent；这些节点随容器重建一起销毁
        input.addEventListener('input', () => {
            this.filter = input.value.trim();
            this.renderList();
        });
        const select = bar.createEl('select', { cls: 'nr-shelf-sort' });
        for (const opt of [
            { value: 'recent', label: '最近阅读' },
            { value: 'title', label: '按书名' },
            { value: 'progress', label: '按进度' },
        ]) {
            select.createEl('option', { value: opt.value, text: opt.label });
        }
        select.value = this.sort;
        select.addEventListener('change', () => {
            this.sort = select.value;
            this.renderList();
        });
        const modeBtn = bar.createEl('button', {
            cls: 'nr-btn nr-shelf-mode',
            text: this.mode === 'grid' ? '列表' : '网格',
        });
        modeBtn.setAttribute('title', this.mode === 'grid' ? '切换成列表' : '切换成网格');
        modeBtn.onclick = () => {
            this.mode = this.mode === 'grid' ? 'list' : 'grid';
            this.host.plugin.data.settings.shelfView = this.mode;
            this.host.plugin.saveSoon();
            this.render();
        };
    }
    renderTabs(parent) {
        const counts = this.counts();
        const wrap = parent.createDiv({ cls: 'nr-shelf-tabs' });
        for (const t of SHELF_TABS) {
            const btn = wrap.createEl('button', {
                cls: `nr-shelf-tab${this.tab === t.id ? ' nr-shelf-tab-on' : ''}`,
                text: `${t.label} ${counts[t.id]}`,
            });
            btn.onclick = () => {
                this.tab = t.id;
                this.render();
            };
        }
    }
    counts() {
        const c = {
            all: 0,
            reading: 0,
            starred: 0,
            unread: 0,
            finished: 0,
        };
        for (const e of this.entries) {
            c.all += 1;
            if (e.starred) {
                c.starred += 1;
            }
            if (e.finished) {
                c.finished += 1;
            }
            else if (e.unread) {
                c.unread += 1;
            }
            else {
                c.reading += 1;
            }
        }
        return c;
    }
    renderSelectionBar(parent) {
        const bar = parent.createDiv({ cls: 'nr-shelf-selbar' });
        bar.createSpan({ cls: 'nr-shelf-selcount', text: `已选 ${this.selected.size} 本` });
        const mk = (label, cls, onClick) => {
            const btn = bar.createEl('button', { cls: `nr-btn ${cls}`.trim(), text: label });
            btn.onclick = onClick;
        };
        mk('全选', '', () => {
            for (const e of this.shown()) {
                this.selected.add(e.key);
            }
            this.render();
        });
        mk('清空', '', () => {
            this.selected.clear();
            this.render();
        });
        mk('收藏', '', () => this.bulkStar(true));
        mk('取消收藏', '', () => this.bulkStar(false));
        mk('移除', 'nr-btn-danger', () => this.bulkRemove());
        mk('完成', '', () => {
            this.selecting = false;
            this.selected.clear();
            this.render();
        });
    }
    bulkStar(on) {
        const plugin = this.host.plugin;
        let n = 0;
        for (const key of this.selected) {
            if (plugin.isStarred(key) !== on) {
                plugin.toggleShelf(key);
                n += 1;
            }
        }
        new obsidian_1.Notice(n > 0 ? `已${on ? '收藏' : '取消收藏'} ${n} 本` : '没有需要变动的书');
        this.afterBulk();
    }
    bulkRemove() {
        const keys = Array.from(this.selected);
        if (keys.length === 0) {
            new obsidian_1.Notice('还没选书');
            return;
        }
        new ConfirmModal(this.app, '从书架移除', `移除选中的 ${keys.length} 本书的阅读记录、收藏、书签与章节配置？`, () => {
            const plugin = this.host.plugin;
            const view = plugin.getActiveReaderView();
            for (const key of keys) {
                plugin.removeFromShelf(key);
                if (view && view.hasSource && view.sourceKey() === key) {
                    view.closeSource();
                }
            }
            new obsidian_1.Notice(`已移除 ${keys.length} 本`);
            this.afterBulk();
        }).open();
    }
    afterBulk() {
        this.selected.clear();
        this.selecting = false;
        this.refresh();
    }
    renderList() {
        const list = this.listEl;
        const hint = this.hintEl;
        if (!list || !hint) {
            return;
        }
        const shown = this.shown();
        list.empty();
        if (shown.length === 0) {
            hint.setText(this.filter.length > 0 || this.tab !== 'all'
                ? '没有符合条件的书'
                : '书架还是空的，从下面浏览库添加一本书吧');
            hint.style.display = '';
            return;
        }
        hint.style.display = 'none';
        const view = this.host.plugin.getActiveReaderView();
        const currentKey = view && view.hasSource ? view.sourceKey() : '';
        for (const entry of shown) {
            const current = entry.key === currentKey;
            if (this.mode === 'grid') {
                this.renderCard(list, entry, current);
            }
            else {
                this.renderRow(list, entry, current);
            }
        }
    }
    shown() {
        const keyword = this.filter.toLowerCase();
        const list = this.entries.filter((e) => {
            if (this.tab === 'starred' && !e.starred) {
                return false;
            }
            if (this.tab === 'unread' && !e.unread) {
                return false;
            }
            if (this.tab === 'finished' && !e.finished) {
                return false;
            }
            if (this.tab === 'reading' && (e.unread || e.finished)) {
                return false;
            }
            if (keyword.length === 0) {
                return true;
            }
            return (e.title.toLowerCase().includes(keyword) ||
                e.realTitle.toLowerCase().includes(keyword) ||
                e.key.toLowerCase().includes(keyword));
        });
        return list.sort((a, b) => {
            // 置顶永远在最前
            if (a.pinned !== b.pinned) {
                return a.pinned ? -1 : 1;
            }
            if (this.sort === 'title') {
                return naturalCompare(a.title, b.title);
            }
            if (this.sort === 'progress') {
                return b.overall - a.overall || b.updatedAt - a.updatedAt;
            }
            return b.updatedAt - a.updatedAt;
        });
    }
    /** 列表行：封面色块 + 书名 + 进度条 + 读到哪了 + 收藏/详情/移除 */
    renderRow(parent, entry, current) {
        const row = parent.createDiv({ cls: 'nr-shelf-item' });
        if (current) {
            row.addClass('nr-shelf-current');
        }
        if (this.selected.has(entry.key)) {
            row.addClass('nr-shelf-picked');
        }
        const box = row.createDiv({
            cls: `nr-shelf-check${this.selecting ? ' nr-shelf-check-on' : ''}`,
            text: this.selecting ? (this.selected.has(entry.key) ? '✓' : '') : '',
        });
        box.setAttribute('title', '选择');
        box.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.toggleSelect(entry.key);
        });
        const cover = row.createDiv({ cls: 'nr-shelf-thumb' });
        cover.style.background = coverGradient(entry.key);
        cover.createDiv({ cls: 'nr-shelf-thumb-letter', text: coverLetter(entry.title) });
        const main = row.createDiv({ cls: 'nr-shelf-main' });
        main.createDiv({ cls: 'nr-shelf-title', text: entry.title });
        const bar = main.createDiv({ cls: 'nr-shelf-bar' });
        const fill = bar.createDiv({ cls: 'nr-shelf-bar-fill' });
        fill.style.width = `${Math.min(100, Math.max(0, entry.overall))}%`;
        main.createDiv({ cls: 'nr-shelf-meta', text: this.metaText(entry, current) });
        if (this.selecting) {
            row.addEventListener('click', () => this.toggleSelect(entry.key));
            return;
        }
        row.addEventListener('click', () => this.openEntry(entry));
        this.mkIcon(row, entry.starred ? '★' : '☆', entry.starred ? '取消收藏' : '加入书架', (btn) => {
            const on = this.host.plugin.toggleShelf(entry.key);
            btn.setText(on ? '★' : '☆');
            btn.toggleClass('nr-shelf-icon-on', on);
            entry.starred = on;
            new obsidian_1.Notice(on ? `已收藏《${entry.title}》` : `已取消收藏《${entry.title}》`);
            this.refreshIfGone(entry);
        });
        this.mkIcon(row, 'ⓘ', '详情', () => this.openDetail(entry));
        this.mkIcon(row, '✕', '从书架移除', () => this.removeOne(entry));
    }
    /** 网格卡片：竖排封面 + 书名 + 进度，右上角收藏、右下角详情 */
    renderCard(parent, entry, current) {
        const card = parent.createDiv({ cls: 'nr-shelf-card' });
        if (current) {
            card.addClass('nr-shelf-current');
        }
        if (this.selected.has(entry.key)) {
            card.addClass('nr-shelf-picked');
        }
        const cover = card.createDiv({ cls: 'nr-shelf-cover' });
        cover.style.background = coverGradient(entry.key);
        cover.createDiv({ cls: 'nr-shelf-cover-letter', text: coverLetter(entry.title) });
        const badges = cover.createDiv({ cls: 'nr-shelf-badges' });
        if (entry.pinned) {
            badges.createDiv({ cls: 'nr-shelf-badge', text: '顶' });
        }
        if (entry.starred) {
            badges.createDiv({ cls: 'nr-shelf-badge', text: '★' });
        }
        if (current) {
            badges.createDiv({ cls: 'nr-shelf-badge nr-shelf-badge-live', text: '在读' });
        }
        const box = cover.createDiv({
            cls: `nr-shelf-check${this.selecting ? ' nr-shelf-check-on' : ''}`,
            text: this.selecting ? (this.selected.has(entry.key) ? '✓' : '') : '',
        });
        box.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.toggleSelect(entry.key);
        });
        const body = card.createDiv({ cls: 'nr-shelf-card-body' });
        body.createDiv({ cls: 'nr-shelf-card-title', text: entry.title });
        body.createDiv({ cls: 'nr-shelf-card-meta', text: this.shortMeta(entry) });
        const bar = body.createDiv({ cls: 'nr-shelf-bar' });
        const fill = bar.createDiv({ cls: 'nr-shelf-bar-fill' });
        fill.style.width = `${Math.min(100, Math.max(0, entry.overall))}%`;
        if (this.selecting) {
            card.addEventListener('click', () => this.toggleSelect(entry.key));
            return;
        }
        card.addEventListener('click', () => this.openEntry(entry));
        const tools = body.createDiv({ cls: 'nr-shelf-card-tools' });
        this.mkIcon(tools, entry.starred ? '★' : '☆', entry.starred ? '取消收藏' : '加入书架', (btn) => {
            const on = this.host.plugin.toggleShelf(entry.key);
            btn.setText(on ? '★' : '☆');
            btn.toggleClass('nr-shelf-icon-on', on);
            entry.starred = on;
            new obsidian_1.Notice(on ? `已收藏《${entry.title}》` : `已取消收藏《${entry.title}》`);
            this.refreshIfGone(entry);
        });
        this.mkIcon(tools, 'ⓘ', '详情', () => this.openDetail(entry));
    }
    mkIcon(parent, text, title, onClick) {
        const btn = parent.createEl('button', {
            cls: `nr-btn nr-shelf-icon-btn${text === '★' ? ' nr-shelf-icon-on' : ''}`,
            text,
            title,
        });
        btn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            onClick(btn);
        });
        return btn;
    }
    toggleSelect(key) {
        if (!this.selecting) {
            this.selecting = true;
        }
        if (this.selected.has(key)) {
            this.selected.delete(key);
        }
        else {
            this.selected.add(key);
        }
        this.render();
    }
    /** 取消收藏后，没真正读过的书就不该继续占着书架 */
    refreshIfGone(entry) {
        const progress = this.host.plugin.data.books[entry.key];
        if (!entry.starred && (!progress || (progress.updatedAt === 0 && progress.overall === 0))) {
            this.refresh();
        }
    }
    metaText(entry, current) {
        const tags = [entry.detail, `已读 ${entry.overall}%`];
        if (entry.chapterTitle) {
            tags.push(entry.chapterCount > 0 ? `读到 ${entry.chapterTitle}` : `读到 ${entry.chapterTitle}`);
        }
        if (entry.updatedAt > 0) {
            tags.push(formatRelative(entry.updatedAt));
        }
        if (entry.bookmarks > 0) {
            tags.push(`${entry.bookmarks} 个书签`);
        }
        if (current) {
            tags.push('正在阅读');
        }
        if (entry.pinned) {
            tags.push('置顶');
        }
        return tags.join(' · ');
    }
    shortMeta(entry) {
        if (entry.unread) {
            return '未读';
        }
        if (entry.finished) {
            return '已读完';
        }
        return `${entry.overall}%`;
    }
    openDetail(entry) {
        new BookDetailModal(this.host.plugin, entry, () => this.refresh()).open();
    }
    removeOne(entry) {
        new ConfirmModal(this.app, '从书架移除', `移除《${entry.title}》的阅读记录、收藏、书签与章节配置？`, () => {
            this.host.plugin.removeFromShelf(entry.key);
            new obsidian_1.Notice(`已移除《${entry.title}》`);
            const view = this.host.plugin.getActiveReaderView();
            if (view && view.hasSource && view.sourceKey() === entry.key) {
                view.closeSource();
            }
            this.refresh();
        }).open();
    }
    renderActions(parent) {
        const actions = parent.createDiv({ cls: 'nr-shelf-actions' });
        const batchBtn = actions.createEl('button', {
            cls: 'nr-btn',
            text: this.selecting ? '退出批量' : '批量',
        });
        batchBtn.onclick = () => {
            this.selecting = !this.selecting;
            this.selected.clear();
            this.render();
        };
        const browseBtn = actions.createEl('button', {
            cls: 'nr-btn nr-btn-primary',
            text: '浏览全库添加书籍',
        });
        browseBtn.onclick = () => {
            new BookBrowserModal(this.host.plugin, () => this.refresh()).open();
        };
    }
    openEntry(entry) {
        const af = this.app.vault.getAbstractFileByPath(entry.key);
        if (af instanceof obsidian_1.TFile) {
            void this.host.plugin.openBook({ kind: 'file', file: af });
        }
        else if (af instanceof obsidian_1.TFolder) {
            void this.host.plugin.openBook({ kind: 'folder', folder: af });
        }
        else {
            new obsidian_1.Notice('这本书已不在库中');
            return;
        }
        if (this.host.closeOnOpen) {
            this.host.close();
        }
    }
}
function coverGradient(key) {
    const h = coverHue(key);
    return `linear-gradient(155deg, hsl(${h}, 42%, 56%), hsl(${(h + 28) % 360}, 38%, 40%))`;
}
/** 阅读器里的书架弹窗：轻量，读着书随手翻一下书架不用切视图 */
class BookshelfModal extends obsidian_1.Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
    }
    onOpen() {
        this.titleEl.setText('书架');
        const wrap = this.contentEl.createDiv({ cls: 'nr-shelf-wrap' });
        new ShelfList({ plugin: this.plugin, closeOnOpen: true, close: () => this.close() }, wrap).refresh();
    }
}
/** 常驻书架视图：左侧图标 / 命令面板打开，和阅读器平级 */
class BookshelfView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.list = null;
        this.refreshTimer = null;
        this.plugin = plugin;
    }
    getViewType() {
        return exports.NOVEL_READER_SHELF_VIEW_TYPE;
    }
    getDisplayText() {
        return '书架';
    }
    getIcon() {
        return 'library';
    }
    async onOpen() {
        this.contentEl.addClass('nr-shelf-view');
        // 库里增删改名都会影响书架；防抖一下，别在同步风暴里反复重画
        const schedule = () => this.scheduleRefresh();
        this.registerEvent(this.app.vault.on('create', schedule));
        this.registerEvent(this.app.vault.on('delete', schedule));
        this.registerEvent(this.app.vault.on('rename', schedule));
        this.render();
    }
    async onClose() {
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    /** 外部（命令、插件事件）要求刷新：直接重取数据 */
    refresh() {
        if (this.list) {
            this.list.refresh();
        }
        else {
            this.render();
        }
    }
    scheduleRefresh() {
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.refresh();
        }, 400);
    }
    render() {
        this.contentEl.empty();
        this.contentEl.addClass('nr-shelf-view');
        const wrap = this.contentEl.createDiv({ cls: 'nr-shelf-wrap' });
        this.list = new ShelfList({ plugin: this.plugin, closeOnOpen: false, close: () => undefined }, wrap);
        this.list.refresh();
    }
}
exports.BookshelfView = BookshelfView;
/** 书籍详情：进度、位置、路径、置顶与显示名都在这里操作 */
class BookDetailModal extends obsidian_1.Modal {
    constructor(plugin, entry, onChanged) {
        super(plugin.app);
        this.plugin = plugin;
        this.entry = entry;
        this.onChanged = onChanged;
    }
    onOpen() {
        const entry = this.entry;
        const plugin = this.plugin;
        this.contentEl.addClass('nr-detail');
        this.titleEl.setText('书籍详情');
        const head = this.contentEl.createDiv({ cls: 'nr-detail-head' });
        const cover = head.createDiv({ cls: 'nr-detail-cover' });
        cover.style.background = coverGradient(entry.key);
        cover.createDiv({ cls: 'nr-shelf-cover-letter', text: coverLetter(entry.title) });
        const headMain = head.createDiv({ cls: 'nr-detail-head-main' });
        headMain.createDiv({ cls: 'nr-detail-title', text: entry.title });
        if (entry.title !== entry.realTitle) {
            headMain.createDiv({ cls: 'nr-detail-sub', text: `原名：${entry.realTitle}` });
        }
        headMain.createDiv({ cls: 'nr-detail-sub', text: entry.detail });
        const progress = plugin.data.books[entry.key];
        const rows = [
            ['进度', `${entry.overall}%${entry.finished ? '（已读完）' : ''}`],
            [
                '位置',
                entry.chapterTitle
                    ? `第 ${(progress ? progress.chapter : 0) + 1} 章 · ${entry.chapterTitle}${entry.chapterCount > 0 ? `（共 ${entry.chapterCount} 章）` : ''}`
                    : entry.chapterCount > 0
                        ? `共 ${entry.chapterCount} 章`
                        : '还没开始读',
            ],
            ['书签', `${entry.bookmarks} 条`],
            ['最后阅读', entry.updatedAt > 0 ? formatRelative(entry.updatedAt) : '从未'],
            ['收藏', entry.starred ? '已收藏' : '未收藏'],
            ['置顶', entry.pinned ? '已置顶' : '未置顶'],
        ];
        for (const [label, value] of rows) {
            const row = this.contentEl.createDiv({ cls: 'nr-detail-row' });
            row.createSpan({ cls: 'nr-detail-label', text: label });
            row.createSpan({ cls: 'nr-detail-value', text: value });
        }
        const pathRow = this.contentEl.createDiv({ cls: 'nr-detail-row' });
        pathRow.createSpan({ cls: 'nr-detail-label', text: '路径' });
        const pathVal = pathRow.createSpan({ cls: 'nr-detail-value nr-detail-path', text: entry.key });
        pathVal.setAttribute('title', '点击复制路径');
        pathVal.addEventListener('click', () => {
            void copyText(entry.key);
        });
        const actions = this.contentEl.createDiv({ cls: 'nr-detail-actions' });
        const mk = (label, cls, onClick) => {
            const btn = actions.createEl('button', { cls: `nr-btn ${cls}`.trim(), text: label });
            btn.onclick = onClick;
        };
        mk('打开', 'nr-btn-primary', () => {
            const af = this.app.vault.getAbstractFileByPath(entry.key);
            if (af instanceof obsidian_1.TFile) {
                void plugin.openBook({ kind: 'file', file: af });
            }
            else if (af instanceof obsidian_1.TFolder) {
                void plugin.openBook({ kind: 'folder', folder: af });
            }
            else {
                new obsidian_1.Notice('这本书已不在库中');
                return;
            }
            this.close();
        });
        mk(entry.pinned ? '取消置顶' : '置顶', '', () => {
            const on = plugin.togglePin(entry.key);
            entry.pinned = on;
            new obsidian_1.Notice(on ? `已置顶《${entry.title}》` : '已取消置顶');
            this.onChanged();
            this.close();
        });
        mk('改显示名', '', () => {
            new TextPromptModal(this.app, '书架显示名', entry.title === entry.realTitle ? '' : entry.title, entry.realTitle, (value) => {
                plugin.setBookAlias(entry.key, value);
                new obsidian_1.Notice(value.trim().length > 0 ? `显示名已改为《${value.trim()}》` : '已恢复真实文件名');
                this.onChanged();
            }).open();
        });
        mk(entry.starred ? '取消收藏' : '收藏', '', () => {
            const on = plugin.toggleShelf(entry.key);
            entry.starred = on;
            new obsidian_1.Notice(on ? `已收藏《${entry.title}》` : `已取消收藏《${entry.title}》`);
            this.onChanged();
            this.close();
        });
        mk('重置进度', '', () => {
            new ConfirmModal(this.app, '重置阅读进度', `把《${entry.title}》的进度清零？收藏与书签会保留。`, () => {
                plugin.resetBookProgress(entry.key);
                new obsidian_1.Notice('进度已重置');
                this.onChanged();
                this.close();
            }).open();
        });
        mk('移除', 'nr-btn-danger', () => {
            new ConfirmModal(this.app, '从书架移除', `移除《${entry.title}》的全部记录？`, () => {
                plugin.removeFromShelf(entry.key);
                new obsidian_1.Notice(`已移除《${entry.title}》`);
                const view = plugin.getActiveReaderView();
                if (view && view.hasSource && view.sourceKey() === entry.key) {
                    view.closeSource();
                }
                this.onChanged();
                this.close();
            }).open();
        });
        if (obsidian_1.Platform.isDesktopApp) {
            mk('在文件管理器中显示', '', () => {
                const api = this.app;
                if (typeof api.openWithDefaultApp === 'function') {
                    api.openWithDefaultApp(entry.key);
                }
                else {
                    new obsidian_1.Notice('当前版本不支持这个操作');
                }
            });
        }
    }
}
/** 单行文本输入弹窗：改显示名这类小输入，移动端也能用 */
class TextPromptModal extends obsidian_1.Modal {
    constructor(app, title, value, placeholder, onSubmit) {
        super(app);
        this.title = title;
        this.value = value;
        this.placeholder = placeholder;
        this.onSubmit = onSubmit;
    }
    onOpen() {
        this.titleEl.setText(this.title);
        const input = this.contentEl.createEl('input', {
            cls: 'nr-prompt-input',
            type: 'text',
            value: this.value,
            placeholder: this.placeholder,
        });
        const submit = () => {
            this.onSubmit(input.value);
            this.close();
        };
        input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter') {
                evt.preventDefault();
                submit();
            }
        });
        const row = this.contentEl.createDiv({ cls: 'nr-pick-actions' });
        const cancel = row.createEl('button', { cls: 'nr-btn', text: '取消' });
        cancel.onclick = () => this.close();
        const ok = row.createEl('button', { cls: 'nr-btn nr-btn-primary', text: '确定' });
        ok.onclick = () => submit();
        window.setTimeout(() => {
            input.focus();
            input.select();
        }, 0);
    }
}
/** 复制文本到剪贴板：移动端没有剪贴板权限时退化成提示 */
async function copyText(text) {
    try {
        const nav = navigator;
        if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
            await nav.clipboard.writeText(text);
            new obsidian_1.Notice('路径已复制');
            return;
        }
    }
    catch (_a) {
        // 剪贴板不可用（部分移动端环境），走下面的兜底提示
    }
    new obsidian_1.Notice(text);
}
/** 浏览全库：搜索 + 打开 + 收藏（没读过也能直接上架） */
class BookBrowserModal extends obsidian_1.Modal {
    constructor(plugin, changed) {
        super(plugin.app);
        this.items = [];
        this.filter = '';
        this.listEl = null;
        this.hintEl = null;
        this.moreBtn = null;
        this.rendered = 0;
        this.plugin = plugin;
        this.changed = changed || null;
    }
    onOpen() {
        this.contentEl.addClass('nr-browse');
        this.titleEl.setText('浏览书库');
        const input = this.contentEl.createEl('input', { cls: 'nr-browse-input', type: 'search' });
        input.placeholder = '搜索书名或路径…';
        input.addEventListener('input', () => {
            this.filter = input.value.trim().toLowerCase();
            this.reset();
        });
        this.hintEl = this.contentEl.createDiv({ cls: 'nr-shelf-hint' });
        this.listEl = this.contentEl.createDiv({ cls: 'nr-browse-list' });
        this.moreBtn = this.contentEl.createEl('button', {
            cls: 'nr-btn nr-toc-more',
            text: '显示更多',
        });
        this.moreBtn.onclick = () => this.renderMore();
        this.items = collectLibrary(this.app, this.plugin.data.settings.deepBrowse).sort((a, b) => comparePaths(itemPath(a), itemPath(b)));
        this.reset();
    }
    onClose() {
        if (this.changed) {
            this.changed();
        }
    }
    reset() {
        if (!this.listEl) {
            return;
        }
        this.listEl.empty();
        this.rendered = 0;
        this.renderMore();
    }
    matched() {
        const keyword = this.filter;
        if (keyword.length === 0) {
            return this.items;
        }
        return this.items.filter((item) => itemPath(item).toLowerCase().includes(keyword));
    }
    /** 分批渲染：库里上千个 md 时一次全建 DOM 会把弹窗卡住 */
    renderMore() {
        const list = this.listEl;
        const hint = this.hintEl;
        const moreBtn = this.moreBtn;
        if (!list || !hint || !moreBtn) {
            return;
        }
        const all = this.matched();
        if (all.length === 0) {
            hint.setText(this.items.length === 0 ? '库里没有可读的 Markdown' : '没有匹配的书');
            hint.style.display = '';
            moreBtn.style.display = 'none';
            return;
        }
        hint.setText(`共 ${all.length} 本，已显示 ${Math.min(all.length, this.rendered + BROWSE_PAGE)} 本`);
        hint.style.display = '';
        const end = Math.min(all.length, this.rendered + BROWSE_PAGE);
        for (let i = this.rendered; i < end; i++) {
            this.renderRow(list, all[i]);
        }
        this.rendered = end;
        moreBtn.style.display = this.rendered < all.length ? '' : 'none';
    }
    renderRow(parent, item) {
        const path = itemPath(item);
        const title = item.kind === 'file' ? item.file.basename : item.folder.name;
        const row = parent.createDiv({ cls: 'nr-browse-item' });
        const main = row.createDiv({ cls: 'nr-browse-main' });
        main.createDiv({ cls: 'nr-browse-title', text: title });
        const tags = item.kind === 'file' ? ['单文件'] : [`文件夹 · ${countMd(item.folder)} 篇`];
        const progress = this.plugin.data.books[path];
        if (this.plugin.isStarred(path)) {
            tags.push('已在书架');
        }
        else if (progress) {
            tags.push(`已读 ${progress.overall}%`);
        }
        main.createDiv({
            cls: 'nr-browse-meta',
            text: `${path.replace(/\.md$/, '')} · ${tags.join(' · ')}`,
        });
        const openBtn = row.createEl('button', { cls: 'nr-btn', text: '打开' });
        openBtn.onclick = () => {
            this.close();
            void this.plugin.openBook(item);
        };
        const starBtn = row.createEl('button', {
            cls: 'nr-btn nr-btn-star',
            text: this.plugin.isStarred(path) ? '★ 移出' : '☆ 加入',
        });
        starBtn.onclick = () => {
            const on = this.plugin.toggleShelf(path);
            starBtn.setText(on ? '★ 移出' : '☆ 加入');
            starBtn.toggleClass('nr-btn-star-on', on);
            new obsidian_1.Notice(on ? `已加入书架：${title}` : `已移出书架：${title}`);
        };
    }
}
function itemPath(item) {
    return item.kind === 'file' ? item.file.path : item.folder.path;
}
/** 库里可选的书：单文件 md 与含 md 的文件夹；deep=false 时只列根目录 */
function collectLibrary(app, deep) {
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
    walk(app.vault.getRoot());
    return items;
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
        return collectLibrary(this.app, this.plugin.data.settings.deepBrowse);
    }
    getItemText(item) {
        const path = itemPath(item);
        // 带上路径，递归浏览时能分清同名章节文件在哪一层
        const label = path.replace(/\.md$/, '');
        const stored = this.plugin.data.books[path];
        const star = this.plugin.isStarred(path) ? '★ ' : '';
        const prefix = stored ? `已读 ${stored.overall}% · ` : '';
        if (item.kind === 'file') {
            return `${star}${prefix}${label} · 单文件`;
        }
        return `${star}${prefix}${label} · 文件夹 · ${countMd(item.folder)} 篇`;
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
/**
 * 文件夹 md 篇数缓存。书架和选书器每次打开都要用它，不缓存就是反复递归整库
 * （选书器还要对每个文件夹再判一次 hasMd，等于 O(n²)）。
 * 失效时机：vault 的 create / delete / rename / md 改动，重建很便宜。
 */
const folderCountCache = new Map();
function invalidateFolderCache() {
    folderCountCache.clear();
}
function countMd(folder) {
    const cached = folderCountCache.get(folder.path);
    if (cached !== undefined) {
        return cached;
    }
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
    folderCountCache.set(folder.path, n);
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
            .setName('书架默认视图')
            .setDesc('书架用网格卡片还是列表打开。书架里随时能切，会记住最后一次的选择')
            .addDropdown((drop) => {
            drop
                .addOption('grid', '网格卡片')
                .addOption('list', '列表')
                .setValue(settings.shelfView)
                .onChange((value) => {
                settings.shelfView = value === 'list' ? 'list' : 'grid';
                this.plugin.saveSoon();
                this.plugin.refreshShelfViews();
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName('清理失效记录')
            .setDesc('删掉文件已不在库的阅读记录，以及只误开过一次、从未真正读过的记录。收藏与库里的文件不受影响')
            .addButton((btn) => {
            btn.setButtonText('清理').onClick(() => {
                new ConfirmModal(this.app, '清理失效记录', '清理文件已不在库的记录，以及从未真正读过且未收藏的记录？书签与收藏会保留。', () => {
                    const result = this.plugin.pruneStale();
                    if (result.missing + result.zombie === 0) {
                        new obsidian_1.Notice('没有需要清理的记录');
                    }
                    else {
                        new obsidian_1.Notice(`已清理 ${result.missing} 条失效记录、${result.zombie} 条未读记录`);
                    }
                    this.display();
                }).open();
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
