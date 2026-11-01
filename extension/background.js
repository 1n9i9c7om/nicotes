// The toolbar button opens the sidebar: Firefox has sidebar_action, Chrome and Edge a side panel.
const api = globalThis.browser ?? globalThis.chrome;

if (api.sidebarAction) {
  api.action.onClicked.addListener(() => api.sidebarAction.toggle());
} else {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}
