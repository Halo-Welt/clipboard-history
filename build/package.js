#!/usr/bin/env node
// 程序化调用 @electron/packager 进行打包
const packager = require('@electron/packager').packager || require('@electron/packager');
const path = require('path');

(async () => {
  try {
    const appPaths = await packager({
      dir: __dirname + '/..',
      out: __dirname + '/../dist',
      name: 'ClipboardHistory',
      platform: 'darwin',
      arch: 'arm64',
      icon: __dirname + '/icon',
      overwrite: true,
      appBundleId: 'com.liuxinyu.clipboard-history',
      appVersion: '1.2.0',
      appCategoryType: 'public.app-category.productivity',
      extendInfo: {
        LSUIElement: true,
        NSHighResolutionCapable: true,
        CFBundleDisplayName: 'ClipboardHistory',
        NSHumanReadableCopyright: 'Copyright © 2026 liuxinyu'
      },
      prune: true,
      ignore: [
        /^\/build($|\/)/,
        /^\/dist($|\/)/,
        /^\/\.workbuddy($|\/)/,
        /^\/start\.sh$/,
        /^\/README\.md$/,
        /^\/\.git($|\/)/,
        /\.DS_Store$/
      ]
    });
    console.log('✓ 打包完成：');
    appPaths.forEach(p => console.log('  ' + p));
  } catch (e) {
    console.error('✗ 打包失败：', e);
    process.exit(1);
  }
})();
