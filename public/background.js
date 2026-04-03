// 点击工具栏图标时在侧边栏打开扩展页面（不新开标签页，当前网页保持在前台）
chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Service Worker 冷启动时也需要注册（否则仅安装当次生效）
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
