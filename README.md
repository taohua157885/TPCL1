# TPCL

TPCL 是一款面向 Windows 的 Minecraft 启动器，提供版本管理、模组与整合包下载、存档备份和启动器插件市场。界面布局参考 [PCL](https://github.com/Meloong-Git/PCL)，支持黑白主题。

[查看 1.25.0 更新日志](CHANGELOG.md)

## 从源码启动

安装 Node.js 22 LTS 或更新版本，在项目根目录运行 `npm start`。要以 Electron 桌面窗口运行，先执行 `npm ci`，再执行 `npm run app`。

- 运行测试：`npm test`
- 构建 Windows 桌面版：`npm run dist`

## 插件市场

点击顶栏的“插件市场”，选择“安装并启用”。在“已安装”中可以停用、重新启用或卸载插件。

通过“导入插件或添加目录”可载入[插件示例](examples/reading-room.plugin.json)。插件可组合字号、列表间距、动画、公告、快捷搜索和首页导航。目录可使用 JSON 数组或含有 `plugins` 数组的对象，通过本地文件或支持 CORS 的 HTTPS 地址分发。提升版本号后再次导入，即可在市场中更新。

## 下载与诊断

在启动页选择目标游戏版本，再从下载页浏览 Modrinth 或 CurseForge。模组安装会自动匹配下载源声明的必需前置。CurseForge 凭据在本机配置。打开下载页的“错误报告”可以导出诊断信息。
