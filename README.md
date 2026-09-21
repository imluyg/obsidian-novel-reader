# Novel Reader

Obsidian 沉浸式小说阅读插件，移动端优先设计。

## 特性（开发中）

- 横向分页阅读（CSS 多列 + scroll-snap）
- 进度按段落锚点记忆，重排不错位
- 字号 / 行高 / 护眼米色 / 暗黑主题
- 支持单文件大书与文件夹分章两种书籍形态

## 安装（测试）

使用 [Brat](https://github.com/TfTHacker/obsidian42-brat) 插件添加本仓库即可安装与更新。

## 开发

```bash
build.bat   # 编译 TS 并部署 main.js
```

- `isDesktopOnly: false`，不依赖 Node/Electron API
- 正则不使用后行断言（兼容 iOS 16.4 以下 WebView）
