(function() {
  var currentTabId = null;

  var updateHTML = function(content) {
    content = content || '<li>No active redirects. <em>(Open the devtools and set redirects rules in the <strong>Redirect</strong> tab.)</em></li>';
    $('#list-resources').html(content);
  };

  var port = chrome.extension.connect({name: 'popup'});
  port.onMessage.addListener(function(msg) {
    if(msg.action === 'updateHTML' && currentTabId === msg.tabId) {
      updateHTML(msg.html);
    }
  });

  chrome.tabs.getSelected(null, function(tab) {
    currentTabId = tab.id;
    port.postMessage({action: 'getPopupHTML', tabId: currentTabId});
  });
})();